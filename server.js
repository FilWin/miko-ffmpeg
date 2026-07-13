/* eslint-disable no-undef */
// Railway Node.js server — not part of the Vite app
const express = require('express');
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const axios = require('axios');
const crypto = require('crypto');

const app = express();
app.use(express.json({ limit: '50mb' }));

const PORT = process.env.PORT || 3000;
const AUTH_TOKEN = process.env.AUTH_TOKEN || '';
const TMP_DIR = '/tmp/ffmpeg';
const RESULTS_DIR = '/tmp/results';

fsp.mkdir(TMP_DIR, { recursive: true }).catch(() => {});
fsp.mkdir(RESULTS_DIR, { recursive: true }).catch(() => {});

const JOBS = new Map();

// ── Auth middleware ─────────────────────────────────────────────────────────
function auth(req, res, next) {
  if (!AUTH_TOKEN) return next();
  const hdr = req.headers.authorization || '';
  if (hdr === `Bearer ${AUTH_TOKEN}`) return next();
  return res.status(401).json({ error: 'Unauthorized' });
}

// ── Helpers ─────────────────────────────────────────────────────────────────
async function downloadFile(url, dest) {
  const res = await axios.get(url, { responseType: 'stream', timeout: 180000, maxContentLength: Infinity });
  const writer = fs.createWriteStream(dest);
  res.data.pipe(writer);
  return new Promise((resolve, reject) => {
    writer.on('finish', resolve);
    writer.on('error', reject);
    res.data.on('error', reject);
  });
}

function probeMedia(filePath) {
  return new Promise((resolve) => {
    execFile('ffprobe', ['-v', 'quiet', '-print_format', 'json', '-show_streams', filePath], (err, stdout) => {
      if (err) return resolve({ hasAudio: false, width: 0, height: 0, rotation: 0 });
      try {
        const data = JSON.parse(stdout);
        const streams = data.streams || [];
        const vStream = streams.find(s => s.codec_type === 'video');
        const hasAudio = streams.some(s => s.codec_type === 'audio');
        let rotation = 0;
        if (vStream?.tags?.rotate) rotation = parseInt(vStream.tags.rotate) || 0;
        if (vStream?.side_data_list) {
          for (const sd of vStream.side_data_list) {
            if (sd.rotation) rotation = Math.round(sd.rotation);
          }
        }
        resolve({
          hasAudio,
          width: vStream?.width || 0,
          height: vStream?.height || 0,
          rotation,
        });
      } catch { resolve({ hasAudio: false, width: 0, height: 0, rotation: 0 }); }
    });
  });
}

function fmtTime(sec) { return Number(sec).toFixed(3); }

function srtTime(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const ms = Math.round((sec % 1) * 1000);
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')},${String(ms).padStart(3,'0')}`;
}

function buildSRT(subtitles) {
  let srt = '';
  subtitles.forEach((entry, i) => {
    srt += `${i + 1}\n${srtTime(entry.start)} --> ${srtTime(entry.end)}\n${entry.text}\n\n`;
  });
  return srt;
}

function parseTimeToSec(timeStr) {
  const parts = timeStr.split(':').map(parseFloat);
  return parts[0] * 3600 + parts[1] * 60 + parts[2];
}

// ── Auto-detect aspect ratio from first clip ─────────────────────────────────
function detectAspectFromProbe(probe, fallback = '16:9') {
  const w = probe.width;
  const h = probe.height;
  if (!w || !h) return fallback;
  const ratio = w / h;
  if (ratio < 0.6) return '9:16';
  if (ratio < 0.85) return '4:5';
  if (ratio < 1.15) return '1:1';
  if (ratio < 1.6) return '4:3';
  return '16:9';
}

// ── Main render ─────────────────────────────────────────────────────────────
async function renderJob(job) {
  const { timeline, dir } = job;
  const { clips, audio_track, subtitles, aspect_ratio, fps = 30, video_audio_muted = false } = timeline;

  const resMap = {
    '16:9': { w: 1280, h: 720 },
    '9:16': { w: 720, h: 1280 },
    '1:1': { w: 1080, h: 1080 },
    '4:3': { w: 1440, h: 1080 },
    '4:5': { w: 1080, h: 1350 },
  };

  // Phase 1: Download clips
  job.status = 'downloading';
  const clipFiles = [];
  for (let i = 0; i < clips.length; i++) {
    const ext = clips[i].url.match(/\.(mp4|mov|webm|mkv)/i)?.[0]?.slice(1) || 'mp4';
    const clipPath = path.join(dir, `clip_${i}.${ext}`);
    await downloadFile(clips[i].url, clipPath);
    clipFiles.push(clipPath);
    job.progress = Math.round(((i + 1) / clips.length) * 20);
  }

  // Download audio
  let audioPath = null;
  if (audio_track?.url) {
    audioPath = path.join(dir, 'audio.mp3');
    await downloadFile(audio_track.url, audioPath);
  }

  // Phase 2: Probe all clips
  const probes = await Promise.all(clipFiles.map(f => probeMedia(f)));

  // Determine output aspect ratio: explicit > auto-detect from first clip
  let outAspect = aspect_ratio;
  if (!outAspect || outAspect === 'auto') {
    outAspect = detectAspectFromProbe(probes[0]);
  }
  const res = resMap[outAspect] || resMap['16:9'];

  // Phase 3: Normalize each clip to intermediate file (avoids filter graph reinit errors)
  job.status = 'rendering';
  job.progress = 25;

  const normalizedFiles = [];
  for (let i = 0; i < clips.length; i++) {
    const clip = clips[i];
    const dur = clip.duration || 5;
    const fadeOut = Math.max(0.01, dur - 0.25);
    const speed = clip.speed || 1;
    const rotation = clip.rotation || 0;
    const flipH = clip.flip_h;
    const flipV = clip.flip_v;
    const trimStart = clip.trim_start || 0;
    const normPath = path.join(dir, `norm_${i}.mp4`);

    // Build video filter chain
    let vf = `scale=${res.w}:${res.h}:force_original_aspect_ratio=increase:force_divisible_by=2,crop=${res.w}:${res.h},setsar=1`;

    if (rotation === 90 || rotation === -270) vf += ',transpose=1';
    else if (rotation === 180 || rotation === -180) vf += ',transpose=2,transpose=2';
    else if (rotation === 270 || rotation === -90) vf += ',transpose=2';

    if (flipH && flipV) vf += ',hflip,vflip';
    else if (flipH) vf += ',hflip';
    else if (flipV) vf += ',vflip';

    vf += `,fade=t=in:st=0:d=0.25,fade=t=out:st=${fmtTime(fadeOut)}:d=0.25,fps=${fps},format=yuv420p`;

    const hasAudio = probes[i].hasAudio && !video_audio_muted;

    const normArgs = hasAudio
      ? ['-ss', fmtTime(trimStart), '-i', clipFiles[i], '-t', fmtTime(dur),
         '-vf', vf,
         '-af', `afade=t=in:st=0:d=0.25,afade=t=out:st=${fmtTime(fadeOut)}:d=0.25` + (speed !== 1 ? `,atempo=${speed.toFixed(6)}` : ''),
         '-c:v', 'libx264', '-preset', 'fast', '-crf', '23', '-pix_fmt', 'yuv420p',
         '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-ac', '2',
         '-y', normPath]
      : ['-ss', fmtTime(trimStart), '-i', clipFiles[i],
         '-f', 'lavfi', '-t', fmtTime(dur), '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
         '-t', fmtTime(dur),
         '-vf', vf,
         '-map', '0:v', '-map', '1:a',
         '-c:v', 'libx264', '-preset', 'fast', '-crf', '23', '-pix_fmt', 'yuv420p',
         '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-ac', '2',
         '-y', normPath];

    console.log(`[Job ${job.id}] Normalizing clip ${i}/${clips.length}`);
    await new Promise((resolve, reject) => {
      const ff = spawn('ffmpeg', normArgs);
      let stderr = '';
      ff.stderr.on('data', (d) => { stderr += d.toString(); });
      ff.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`Clip ${i} normalize failed (${code}): ${stderr.slice(-500)}`));
      });
      ff.on('error', reject);
    });

    normalizedFiles.push(normPath);
    job.progress = Math.min(60, 25 + Math.round(((i + 1) / clips.length) * 35));
  }

  // Phase 4: Concat normalized clips + audio overlay + subtitles
  const listPath = path.join(dir, 'concat_list.txt');
  const listContent = normalizedFiles.map(f => `file '${f.replace(/'/g, "'\\''")}'`).join('\n');
  await fsp.writeFile(listPath, listContent, 'utf-8');

  const outputPath = path.join(RESULTS_DIR, `${job.id}.mp4`);
  const needFilters = audioPath || (subtitles && subtitles.length > 0);

  if (!needFilters) {
    await new Promise((resolve, reject) => {
      const ff = spawn('ffmpeg', [
        '-f', 'concat', '-safe', '0', '-i', listPath,
        '-c', 'copy', '-movflags', '+faststart', '-y', outputPath,
      ]);
      let stderr = '';
      ff.stderr.on('data', (d) => { stderr += d.toString(); });
      ff.on('close', (code) => code === 0 ? resolve() : reject(new Error(`Concat failed (${code}): ${stderr.slice(-500)}`)));
      ff.on('error', reject);
    });
  } else {
    const inputs2 = ['-f', 'concat', '-safe', '0', '-i', listPath];
    if (audioPath) inputs2.push('-i', audioPath);

    const filters2 = [];
    let videoOut = '0:v';
    let audioOut = '0:a';

    if (audioPath) {
      const vol = audio_track.volume ?? 0.8;
      const delayMs = Math.round((audio_track.start || 0) * 1000);
      const trimStart = audio_track.trim || 0;
      filters2.push(`[1:a]atrim=${fmtTime(trimStart)},volume=${vol},adelay=${delayMs}|${delayMs}[aover]`);
      filters2.push(`[0:a][aover]amix=inputs=2:duration=first:dropout_transition=0[aout]`);
      audioOut = '[aout]';
    }

    if (subtitles && subtitles.length > 0) {
      const srtContent = buildSRT(subtitles);
      const srtPath = path.join(dir, 'subtitles.srt');
      await fsp.writeFile(srtPath, srtContent, 'utf-8');
      const escaped = srtPath.replace(/'/g, "\\'").replace(/:/g, '\\:');
      const vSrc = audioPath ? '[0:v]' : '0:v';
      filters2.push(`${vSrc}subtitles='${escaped}':force_style='FontSize=22,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=1,Outline=2,Shadow=1,Alignment=2,MarginV=40'[vsub]`);
      videoOut = '[vsub]';
    }

    const args2 = [
      ...inputs2,
      '-filter_complex', filters2.join(';'),
      '-map', videoOut, '-map', audioOut,
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '23', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '160k',
      '-movflags', '+faststart', '-y', outputPath,
    ];

    await new Promise((resolve, reject) => {
      const ff = spawn('ffmpeg', args2);
      let stderr = '';
      ff.stderr.on('data', (d) => {
        stderr += d.toString();
        const m = stderr.match(/time=(\d{2}:\d{2}:\d{2}\.\d{2})/);
        if (m) {
          const rendered = parseTimeToSec(m[1]);
          job.progress = Math.min(95, 60 + Math.round(35 * (rendered / job.totalDuration)));
        }
      });
      ff.on('close', (code) => code === 0 ? resolve() : reject(new Error(`Final encode failed (${code}): ${stderr.slice(-500)}`)));
      ff.on('error', reject);
    });
  }

  job.status = 'completed';
  job.progress = 100;
  job.resultUrl = `/results/${job.id}.mp4`;
  console.log(`[Job ${job.id}] Completed: ${outputPath}`);

  // Cleanup
  try { await fsp.rm(dir, { recursive: true, force: true }); } catch {}
}

// ── Routes ──────────────────────────────────────────────────────────────────
app.post('/render', auth, async (req, res) => {
  try {
    const { clips, audio_track, subtitles, aspect_ratio } = req.body;
    if (!clips || clips.length === 0) return res.status(400).json({ error: 'No clips' });

    const jobId = crypto.randomUUID();
    const jobDir = path.join(TMP_DIR, jobId);
    await fsp.mkdir(jobDir, { recursive: true });

    const totalDuration = clips.reduce((s, c) => s + (c.duration || 5), 0);

    const job = {
      id: jobId,
      status: 'pending',
      progress: 0,
      error: null,
      resultUrl: null,
      dir: jobDir,
      timeline: req.body,
      totalDuration,
      createdAt: Date.now(),
    };
    JOBS.set(jobId, job);

    renderJob(job).catch(err => {
      console.error(`[Job ${jobId}] FAILED:`, err.message);
      job.status = 'failed';
      job.error = err.message;
    });

    res.json({ job_id: jobId, status: 'pending' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/status/:jobId', auth, (req, res) => {
  const job = JOBS.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json({
    status: job.status,
    progress: Math.round(job.progress),
    error: job.error,
    result_url: job.resultUrl,
  });
});

app.get('/results/:file', (req, res) => {
  const filePath = path.join(RESULTS_DIR, req.params.file);
  if (!fs.existsSync(filePath)) return res.status(404).send('Not found');
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Content-Disposition', 'inline');
  res.sendFile(filePath);
});

app.delete('/cleanup/:jobId', auth, async (req, res) => {
  const job = JOBS.get(req.params.jobId);
  if (job) {
    const filePath = path.join(RESULTS_DIR, `${job.id}.mp4`);
    try { await fsp.unlink(filePath); } catch {}
    try { await fsp.rm(job.dir, { recursive: true, force: true }); } catch {}
    JOBS.delete(req.params.jobId);
  }
  res.json({ ok: true });
});

app.get('/health', (req, res) => {
  res.json({ ok: true, jobs: JOBS.size });
});

// Cleanup old jobs (every 30 min)
setInterval(() => {
  const now = Date.now();
  for (const [id, job] of JOBS) {
    if (now - job.createdAt > 2 * 60 * 60 * 1000) {
      const fp = path.join(RESULTS_DIR, `${id}.mp4`);
      try { fs.unlinkSync(fp); } catch {}
      try { fs.rmSync(job.dir, { recursive: true, force: true }); } catch {}
      JOBS.delete(id);
    }
  }
}, 30 * 60 * 1000);

app.listen(PORT, () => console.log(`FFmpeg render server on :${PORT}`));
