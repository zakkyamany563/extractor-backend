import dotenv from "dotenv";
dotenv.config();
import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import multer from "multer";
import { v2 as cloudinary } from "cloudinary";
import ffmpegPath from "ffmpeg-static";
import Ffmpeg from "fluent-ffmpeg";
import path from "path"
import fs from "fs"
import ffprobe from "ffprobe-static"
import axios from "axios"
import FormData from "form-data";
import crypto from "crypto";
import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

//config ffmpeg
Ffmpeg.setFfmpegPath(ffmpegPath);
Ffmpeg.setFfprobePath(ffprobe.path);

//inisialisasi dan config expressjs
const app = express();
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(cors({
    origin: "*"
}));


// Buat folder jika belum ada
const requiredDirs = ["frames", "audio", "uploads"];
requiredDirs.forEach((dir) => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        console.log(`📁 Folder '${dir}' dibuat`);
    } else {
        console.log(`📁 Folder '${dir}' sudah ada`);
    }
});

console.log("====================================================")
console.log("                 DEBUG ENV")
console.log("====================================================")
console.table({
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    CLOUDINARY_CLOUD_NAME: process.env.CLOUDINARY_CLOUD_NAME,
    CLOUDINARY_API_KEY: process.env.CLOUDINARY_API_KEY,
    CLOUDINARY_API_SECRET: process.env.CLOUDINARY_API_SECRET,
    PORT: process.env.PORT
})

//config cloudinary
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

//config multer(midleware untuk req file)
const upload = multer({ dest: "./uploads" });

//route(url/method) untuk penilaian video
app.post("/", upload.single("video"), async (req, res) => {
    try {

        //validasi apakah ada req file
        if (!req.file) {
            return res.status(400).json({ message: "No file uploaded." });
        }

        //validasi apakah file yg diupload adalah video
        if (req.file.mimetype !== "video/mp4") {
            return res.status(400).json({ message: "Invalid file type. Only MP4 files are allowed." });
        }

        //mendapatakan hash file
        const identifier = await getfilehash(req.file.path)
        console.log(identifier)
        //melakukan query ke database(mencari data pada table analyze untuk identifier yg telah dibuat sesauai video yg diupload)
        const existingVideo = await prisma.analyze.findUnique({
            where: {
                identifier: identifier
            }
        })

        //jika data sudah ada maka kembalikan data
        if (existingVideo) {
            return res.status(200).json({
                message: "Video Already Analyzed",
                data: existingVideo.result
            })
        }

        //==================START FUNGSI FRAMES===========================
        //deklarasi folder/directory untuk frame
        const framedirectory = path.join("frames", `frame-${Date.now()}`)

        //jika gaada maka buat directory untuk frame nanti disimpan
        if (!fs.existsSync(framedirectory)) {
            fs.mkdirSync(framedirectory)
        }
        //mendapatkan metadata video (durasi, dll)
        const metaVideo = await new Promise((resolve, reject) => {
            Ffmpeg.ffprobe(req.file.path, (error, data) => {
                if (error) {
                    reject(error)
                } else {
                    resolve(data)
                }
            })
        })

        //cari stream untuk tipe video(soalnya streams ada banyak termasuk audio)
        const videostreaminfo = metaVideo.streams.find((item) => {
            return item.codec_type === "video"
        })
        //ambil meta data yg diperlukan
        const duration = metaVideo.format.duration
        const width = videostreaminfo.width
        const height = videostreaminfo.height
        const format = req.file.mimetype
        const size = req.file.size

        if (duration > 200) {
            return res.status(400).json({
                message: "Video Terlalu Panjang"
            })
        }

        //deklarasi folder/directory untuk nantinya digunakan menyimpann tiap frame
        const framepattern = path.join(framedirectory, `frame-%03d.jpeg`)

        //mengekstark video menjadi frame
        await new Promise((resolve, reject) => {
            Ffmpeg(req.file.path)
                .outputOptions(["-vf", "fps=1/1"]) //fps = 1/1 adalah 1 detik = 1 frame
                .output(framepattern) //output frame diletakan
                .on("end", resolve)
                .on("error", reject)
                .run()
        })

        //membaca seluruh frame yg telah diekstrak pada folder "/frames/frame-datenow"
        const frames = fs.readdirSync(framedirectory)

        //membuat fungsi untuk upload frame dalam array(jadi fungsinya disimpan tp blm dipanggil)
        const uploadPromises = frames.map(frame => { //fungsinya disimpan
            return cloudinary.uploader.upload(path.join(framedirectory, frame));
        });
        //menjalankan semua fungsi upload frame yg disimpann
        const uploadFrames = await Promise.all(uploadPromises);
        //==================END FUNGSI FRAMES===========================


        //==================START FUNGSI AUDIO===========================

        //membuat nama audio agar sesuai waktu
        const audiofilename = `audio-${Date.now()}.wav`
        //deklarasi directory/folder untuk audio yg akan digunakan
        const audiopath = path.join("audio", audiofilename)

        //ekstrak audio
        await new Promise((resolve, reject) => {
            Ffmpeg(req.file.path)
                .noVideo()
                .audioCodec("pcm_s16le")
                .format("wav")
                .save(audiopath) //tempat file disimpan yaitu pada yg sudah di deklarasi const audiopath
                .on("end", resolve)
                .on("error", reject)

        })

        //mendapatkan metadata untuk audio
        const metaAudio = await new Promise((resolve, reject) => {
            Ffmpeg.ffprobe(audiopath, (error, data) => {
                if (error) {
                    reject(error)
                } else {
                    resolve(data)
                }
            })
        })

        //mencari metadata streams untuk tipe audio karena streams array
        const audiostreamdata = metaAudio.streams.find((item) => {
            return item.codec_type === "audio"
        })

        //deklarasi metadata yg digunakan
        const samplerate = audiostreamdata?.sample_rate
        const channels = audiostreamdata?.channels
        const channellayout = channels == 2 ? "stereo" : "mono"

        //menguplad audio ke cloudinary diampil dr audiopath(path/tempat audio itu disimpan di lokal/komputerku)
        const uploadaudio = await cloudinary.uploader.upload(audiopath, {
            resource_type: "auto",
            use_filename: true,
            unique_filename: true

        })

        //==================END FUNGSI AUDIO===========================


        // ✅ Upload ke Cloudinary dari path lokal (video yg diupload)
        const uploadvideo = await cloudinary.uploader.upload(req.file.path, { //req file = video yg diupload
            resource_type: "auto", // atau auto
        });

        //seting tiap section % durasi video
        const sectionsettings = [
            {
                name: "opening",
                percent: 10
            },
            {
                name: "setup",
                percent: 20
            },
            {
                name: "main",
                percent: 60
            },
            {
                name: "climax",
                percent: 90
            },
            {
                name: "closing",
                percent: 100
            }
        ]

        //memfilter hasil tiap frame yg dugunakan spt name,url
        const filteredFrames = uploadFrames.map((item, index) => {
            return {
                url: item.secure_url,
                name: item.original_filename,
                timestamp: index + 1
            }
        })

        //mengelompokkan tiap section dimulai dr beri array kosong karena push(nambah ke array yg kosong)
        const categorizedFrames = {
            opening: [],
            setup: [],
            main: [],
            climax: [],
            closing: [],
        }

        //mengelompokkan tiap section berdasakan persentase
        filteredFrames.forEach((frame, index) => {
            const section = sectionsettings.find((s) => {
                return s.percent > (index / filteredFrames.length) * 100
            })
            categorizedFrames[section.name].push(frame)
        })

        //melakukan transcribe audio
        const fullAudio = await audioGPT(audiopath)

        //membuat prompt berdasarkan tiap section
        const openingPrompt = buildPrompt("opening", fullAudio, categorizedFrames.opening)
        const setupPrompt = buildPrompt("setup", fullAudio, categorizedFrames.setup)
        const mainPrompt = buildPrompt("main", fullAudio, categorizedFrames.main)
        const climaxPrompt = buildPrompt("climax", fullAudio, categorizedFrames.climax)
        const closingPrompt = buildPrompt("closing", fullAudio, categorizedFrames.closing)




        //mendapatkan hasil penilaian tiap section secara paralel
        const [openingResult, setupResult, mainResult, climaxResult, closingResult] = await Promise.all([
            chatGPT(openingPrompt),
            chatGPT(setupPrompt),
            chatGPT(mainPrompt),
            chatGPT(climaxPrompt),
            chatGPT(closingPrompt),
        ])

        //mengambil hasil penilaian menjadi JSON agar bisa diakses ke frontend
        const opening = JSON.parse(openingResult?.choices?.[0]?.message?.content)
        const setup = JSON.parse(setupResult?.choices?.[0]?.message?.content)
        const main = JSON.parse(mainResult?.choices?.[0]?.message?.content)
        const climax = JSON.parse(climaxResult?.choices?.[0]?.message?.content)
        const closing = JSON.parse(closingResult?.choices?.[0]?.message?.content)

        //inisiasi variabel untuk review
        let totalReview = 0;
        let positiveReview = 0;

        //melakukan perulangan untuk menghitung total dan positive review
        for (const section of [opening, setup, main, climax, closing]) {
            totalReview += section?.assessmentIndicators?.length;
            positiveReview += section?.assessmentIndicators?.filter((indicator) => indicator?.value === true)?.length;
        }

        //menghitung persentase
        const positivePercentage = (positiveReview / totalReview) * 100;

        //membuat objek review
        const review = {
            totalReview: totalReview,
            positiveReview: positiveReview,
            positivePercentage: positivePercentage
        }

        //membuat summary prompt
        const summaryPrompt = buildSummaryPrompt(opening, setup, main, climax, closing, fullAudio, filteredFrames.map((item) => item.url).slice(0, 20))
        console.log({ summaryPrompt })
        //membuat penilaian untuk summary
        const summaryResult = await chatGPT(summaryPrompt)
        console.log({ summaryResult })
        //membuat penilaian menjadi json untuk summary
        const summary = JSON.parse(summaryResult.choices?.[0]?.message?.content)
        console.log({ summary })


        //data yg akan dikirimkan
        const result = {
            metadataVideo: {
                duration: duration,
                width: width,
                height: height,
                format: format,
                size: size,
                url: uploadvideo.secure_url
            },
            metadataAudio: {
                sampleRate: samplerate,
                channels: channels,
                channelLayout: channellayout,
                url: uploadaudio.secure_url
            },
            frames: categorizedFrames,
            review: review,
            analyze: {
                opening: opening,
                setup: setup,
                main: main,
                climax: climax,
                closing: closing,
                summary: summary
            }
        }

        //menyimpan hasil ke database
        await prisma.analyze.create({
            data: {
                identifier: identifier,
                result: result
            }
        })


        //mengembalikan respon
        return res.json({
            message: "berhasil upload",
            data: result
        });


    } catch (error) {
        console.error(error);
        return res.status(500).json({
            message: "Gagal upload",
            error: error.message || "Unknown error",
        });
    }
});



//membuat fungsi chatGPT untuk prompt ke gpt
async function chatGPT(messages) {
    const response = await axios.post("https://api.openai.com/v1/chat/completions", {
        model: "gpt-4o",
        messages: [
            {
                role: "system",
                content: "you re proffesional video analyzer"
            }, {
                role: "user",
                content: messages
            }
        ],
        response_format: { type: "json_object" }
    }, {
        headers: {
            Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
        }
    })
    return response.data
}
//fungsi untuk membuat prompt dari riap section agar hasilnya sesuai

function buildPrompt(segmentName, transcribeAudio, segmentFrames) {
    return `
You are reviewing a promotional video segment for a vehicle rental business, as if you were a typical TikTok or Reels viewer.

Segment: "${segmentName}"
Frames: ${segmentFrames.map((s) => s.url).join(", ")}
Transcript: ${transcribeAudio}

Use the following assessment indicators — but ONLY assess the ones that apply to this specific segment.  
**Do NOT assess indicators that do not logically belong in this segment. For example, only assess "Effective Call to Action" in the closing segment, and "Engaging Hook" in the opening segment.**

Assessment Indicators:
- Engaging Hook (**only in opening**)
- Effective Call to Action (**only in closing**)
- Rental Activity Footage (**only in main**)
- Trending Music (**assess whole video**)
- Visual Clarity (**whole video**)
- Proper Video Format (vertical, under 60s) (**whole video**)
- Content Relevance (e.g., rental visuals, cars, customers) (**whole video**)
- Local Context (e.g., local language, setting) (**whole video**)

**IMPORTANT:**
- Set "value": true by default unless there is clear evidence it is missing or poorly executed.
- If unsure or partially present, still set to true.
- Only use "value": false if it’s definitely absent.
- Be positive and constructive. Most values should be true in a generally good video.
- this is an promotional video analyzer, if the video don't have any correlation with promotional content especially msme, please make it false.

Return ONLY a JSON object like this:
{
  "recommendations": [
    {
      "point": "string",
      "example": "string"
    }
  ],
  "assessmentIndicators": [
    { "name": "<indicator_name>", "value": true/false },
    ...
  ]
}
`;
}

function buildSummaryPrompt(opening, setup, main, climax, closing, audio, frames) {
    return `
You are given the assessment results of each video segment:

Opening: ${JSON.stringify(opening)},  
Setup: ${JSON.stringify(setup)},  
Main: ${JSON.stringify(main)},  
Climax: ${JSON.stringify(climax)},  
Closing: ${JSON.stringify(closing)}

Full transcript of audio:
${audio}

Frames from video:
${frames.join(", ")}

Do NOT summarize or re-assess the segments.  
Instead, answer clearly: **"What is the video about, and what happens from beginning to end?"**  
(e.g., "A video showcasing a car rental service. It begins with an exterior shot of the business, shows customers picking up cars, highlights the features, and ends with a CTA to book.")

Return ONLY a JSON object:
{
  "recommendations": [string, ...],
  "assessmentIndicators": [
    { "name": "<indicator_name>", "value": true/false },
    ...
  ],
  "summary": "string"
}
`;
}


//membuat fungsi untuk transcribe audio
async function audioGPT(audioPath) {
    const form = new FormData()
    form.append("file", fs.createReadStream(audioPath))
    form.append("model", "whisper-1")
    const response = await axios.post("https://api.openai.com/v1/audio/transcriptions", form, {
        headers: {
            Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        }
    })
    return response.data
}


//membuat fungsi untuk mendapatkan hash file
function getfilehash(filepath) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        const stream = fs.createReadStream(filepath);
        stream.on('data', (chunk) => {
            hash.update(chunk);
        });
        stream.on('end', () => {
            resolve(hash.digest('hex'));
        });
        stream.on('error', (err) => {
            reject(err);
        });
    })
}

//membuat port
const PORT = process.env.PORT
//membust server
app.listen(PORT, () => {
    console.log(`🚀 Server running at http://localhost:${PORT}`);
});
