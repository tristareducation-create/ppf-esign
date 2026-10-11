const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '8mb' }));
app.use('/static', express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));

const ORIGINAL = fs.readFileSync(path.join(__dirname, 'assets', 'bond.pdf'));
const ORIGINAL_SHA = crypto.createHash('sha256').update(ORIGINAL).digest('hex');
const OUT = process.env.OUT_DIR || '/tmp/signed';
fs.mkdirSync(OUT, { recursive: true });
const ADMIN = process.env.ADMIN_TOKEN || '';
const NOTIFY = (process.env.NOTIFY_TO || 'danish@tristar.education,admissions@tseducation.org').split(',').map(s => s.trim()).filter(Boolean);
const PAGES = 4;

function pkt(d) {
  const t = new Date(d.getTime() + 5 * 3600 * 1000);
  const p = n => String(n).padStart(2, '0');
  const mon = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][t.getUTCMonth()];
  return `${p(t.getUTCDate())} ${mon} ${t.getUTCFullYear()} ${p(t.getUTCHours())}:${p(t.getUTCMinutes())}:${p(t.getUTCSeconds())} PKT`;
}
function clientIp(req) {
  const xf = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return xf || req.ip || req.socket.remoteAddress || 'unknown';
}
const ascii = s => String(s).replace(/[^\x20-\x7E]/g, '?');
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let transport = null;
if (process.env.SMTP_USER && process.env.SMTP_PASS) {
  transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtppro.zoho.com', port: Number(process.env.SMTP_PORT || 465),
    secure: Number(process.env.SMTP_PORT || 465) === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 30000,
  });
}

async function buildSigned({ name, email, sigs, ip, when, docId, ua }) {
  const pdf = await PDFDocument.load(ORIGINAL);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const pages = pdf.getPages();
  const stamp = `E-signed by ${ascii(name)} | IP ${ip} | ${pkt(when)} | Doc ID ${docId}`;
  for (let i = 0; i < pages.length; i++) {
    const pg = pages[i];
    const png = await pdf.embedPng(Buffer.from(sigs[i].split(',')[1], 'base64'));
    const h = 26, w = Math.min(130, (png.width / png.height) * h);
    pg.drawImage(png, { x: 432, y: 36, width: w, height: h });
    pg.drawText(stamp, { x: 48, y: 14, size: 6.5, font, color: rgb(0.1, 0.2, 0.55) });
  }
  // Page 1: player name + email
  pages[0].drawText(ascii(name), { x: 114, y: 696, size: 10, font: bold, color: rgb(0.05, 0.1, 0.45) });
  pages[0].drawText(ascii(email), { x: 128, y: 588, size: 10, font: bold, color: rgb(0.05, 0.1, 0.45) });
  // Page 4: player name + date
  const p4 = pages[3];
  p4.drawText(ascii(name), { x: 114, y: 614, size: 10, font: bold, color: rgb(0.05, 0.1, 0.45) });
  p4.drawText(pkt(when), { x: 78, y: 602, size: 10, font: bold, color: rgb(0.05, 0.1, 0.45) });

  // Audit certificate page
  const c = pdf.addPage([595.28, 841.89]);
  let y = 780;
  const line = (t, f = font, s = 10) => { c.drawText(ascii(t), { x: 48, y, size: s, font: f }); y -= s + 8; };
  line('Electronic Signature Certificate', bold, 16); y -= 6;
  line('Pakistan Padel Federation - Bond of Undertaking (Travel)', bold, 11);
  line('5th World Cup qualifiers (Asia and Africa) - Kuwait, 26-30 October 2026');
  y -= 8;
  line(`Document ID: ${docId}`, bold);
  line(`Signer name: ${name}`);
  line(`Signer email: ${email}`);
  line(`Signed at: ${pkt(when)} (${when.toISOString()} UTC)`);
  line(`Signer IP address: ${ip}`);
  line(`User agent: ${String(ua || '').slice(0, 95)}`, font, 8);
  line(`Pages signed: ${PAGES} of ${PAGES} (signature drawn separately on each page)`);
  line('Signer ticked: "I have read and agree to all clauses, including Clause 11 (no family/spouses - professional tour)."', font, 8);
  line(`SHA-256 of unsigned document: ${ORIGINAL_SHA}`, font, 8);
  y -= 10;
  line('Copies for: signer, danish@tristar.education, admissions@tseducation.org', font, 9);
  return Buffer.from(await pdf.save());
}

app.get('/', (req, res) => res.type('html').send(PAGE));
app.get('/healthz', (req, res) => res.json({ ok: true, email: !!transport }));

app.post('/api/sign', async (req, res) => {
  try {
    const { name, email, sigs, agree } = req.body || {};
    if (!name || String(name).trim().length < 3) return res.status(400).json({ error: 'Enter your full name.' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || ''))) return res.status(400).json({ error: 'Enter a valid email.' });
    if (!agree) return res.status(400).json({ error: 'Tick the agreement box.' });
    if (!Array.isArray(sigs) || sigs.length !== PAGES || sigs.some(s => !/^data:image\/png;base64,/.test(s || '')))
      return res.status(400).json({ error: 'Sign every page.' });
    const when = new Date();
    const ip = clientIp(req);
    const ymd = new Date(when.getTime() + 5 * 3600e3).toISOString().slice(0, 10).replace(/-/g, '');
    const docId = `PPF-KW26-${ymd}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
    const nm = String(name).trim().slice(0, 80), em = String(email).trim().slice(0, 120);
    const pdf = await buildSigned({ name: nm, email: em, sigs, ip, when, docId, ua: req.headers['user-agent'] });
    const safe = nm.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'Player';
    const file = `${docId}_${safe}.pdf`;
    fs.writeFileSync(path.join(OUT, file), pdf);
    fs.writeFileSync(path.join(OUT, file + '.json'), JSON.stringify({ docId, name: nm, email: em, ip, signedAtPKT: pkt(when), signedAtUTC: when.toISOString(), file }, null, 2));
    const key = crypto.createHmac('sha256', ADMIN || 'k').update(file).digest('hex').slice(0, 24);
    const meta = path.join(OUT, file + '.json');
    const sendMail = async () => {
      let emailed = false, emailError = transport ? null : 'email not configured';
      if (transport) {
      try {
        await transport.sendMail({
          from: `"Pakistan Padel Federation e-sign" <${process.env.SMTP_FROM || process.env.SMTP_USER}>`,
          to: [em, ...NOTIFY].join(', '),
          subject: `Signed: PPF Bond of Undertaking (Travel) Kuwait 2026 - ${nm} - ${docId}`,
          text: `The Pakistan Padel Federation Bond of Undertaking (Travel) for the 5th World Cup qualifiers, Kuwait 26-30 October 2026, has been e-signed.\n\nPlayer: ${nm}\nEmail: ${em}\nSigned: ${pkt(when)}\nIP: ${ip}\nDocument ID: ${docId}\n\nThe signed PDF is attached.`,
          attachments: [{ filename: file, content: pdf }],
        });
        emailed = true;
      } catch (e) { emailError = String(e.message || e); console.error('email failed', docId, emailError); }
      }
      const j = JSON.parse(fs.readFileSync(meta)); j.emailed = emailed; j.emailError = emailError; fs.writeFileSync(meta, JSON.stringify(j, null, 2));
    };
    sendMail().catch(e => console.error(e));

    console.log('SIGNED', docId, nm, em, ip);
    res.json({ ok: true, docId, download: `/d/${encodeURIComponent(file)}?k=${key}` });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not complete signing. Please try again.' });
  }
});

app.get('/d/:file', (req, res) => {
  const file = path.basename(req.params.file);
  const key = crypto.createHmac('sha256', ADMIN || 'k').update(file).digest('hex').slice(0, 24);
  if (req.query.k !== key || !fs.existsSync(path.join(OUT, file))) return res.status(404).send('Not found');
  res.download(path.join(OUT, file));
});

function admin(req, res, next) {
  if (!ADMIN || req.headers['x-admin-token'] !== ADMIN) return res.status(401).end();
  next();
}
app.get('/admin/smtp', admin, async (req, res) => { if (!transport) return res.json({ ok: false, error: 'no transport' }); try { await transport.verify(); res.json({ ok: true }); } catch (e) { res.json({ ok: false, error: String(e.message || e) }); } });
app.get('/admin/list', admin, (req, res) => res.json(fs.readdirSync(OUT).filter(f => f.endsWith('.pdf') || f.endsWith('.json'))));
app.get('/admin/file/:file', admin, (req, res) => res.sendFile(path.join(OUT, path.basename(req.params.file))));

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>PPF Bond of Undertaking (Travel) - Kuwait 2026 - e-sign</title>
<style>
body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;margin:0;background:#f3f5f8;color:#111}
header{background:#0b5d2a;color:#fff;padding:16px}header h1{font-size:18px;margin:0}header p{margin:4px 0 0;font-size:13px;opacity:.9}
main{max-width:820px;margin:0 auto;padding:12px}
.card{background:#fff;border:1px solid #d6dbe1;border-radius:10px;padding:14px;margin:12px 0}
.page img{width:100%;border:1px solid #ccc;display:block}
canvas{width:100%;height:140px;border:2px dashed #0b5d2a;border-radius:8px;touch-action:none;background:#fff}
label{display:block;font-weight:600;margin:10px 0 4px}input[type=text],input[type=email]{width:100%;box-sizing:border-box;padding:11px;font-size:16px;border:1px solid #aab;border-radius:8px}
button{font-size:16px;padding:12px 18px;border-radius:8px;border:0;background:#0b5d2a;color:#fff;cursor:pointer}
button.ghost{background:#eee;color:#111;font-size:13px;padding:6px 10px;margin-top:6px}
.note{background:#fff7e0;border:1px solid #f0c040;padding:10px;border-radius:8px;font-size:14px}
.err{color:#b00020;font-weight:600}.ok{color:#0b5d2a}
.row{display:flex;gap:8px;align-items:center;justify-content:space-between}
</style></head><body>
<header><h1>Pakistan Padel Federation - Bond of Undertaking (Travel)</h1><p>Pakistan men's team - 5th World Cup qualifiers (Asia and Africa) - Kuwait, 26-30 October 2026</p></header>
<main>
<div class="card"><b>How to sign:</b> read each page, draw your signature in the box under it (all 4 pages), enter your name and email, tick the box and press Sign. You can download your signed PDF straight away and the federation receives a copy.
<div class="note" style="margin-top:8px"><b>Clause 11:</b> This is a professional tour. Family members, including spouses, are not allowed to accompany the player.</div>
<p><a href="/static/bond.pdf" target="_blank">Open the full PDF</a></p></div>
<div id="pages"></div>
<div class="card">
<label for="name">Player full name</label><input id="name" type="text" autocomplete="name" placeholder="As on passport">
<label for="email">Player email</label><input id="email" type="email" autocomplete="email" placeholder="you@example.com">
<label style="font-weight:400;margin-top:14px"><input id="agree" type="checkbox"> I have read and agree to all clauses of this Bond of Undertaking, including Clause 11 (family members and spouses are not allowed - professional tour), and I agree that my electronic signature on each page is my legal signature.</label>
<p id="msg"></p><button id="go">Sign and submit</button>
</div>
<div id="done" class="card" style="display:none"></div>
</main>
<script>
const N=${PAGES};const pads=[];
const wrap=document.getElementById('pages');
for(let i=1;i<=N;i++){
 const d=document.createElement('div');d.className='card page';
 d.innerHTML='<img loading="lazy" src="/static/p-'+i+'.png" alt="Page '+i+'"><div class="row"><label>Sign page '+i+' of '+N+'</label><button class="ghost" type="button">Clear</button></div><canvas></canvas>';
 wrap.appendChild(d);
 const c=d.querySelector('canvas');const pad={c,drawn:false};pads.push(pad);
 const fit=()=>{const r=c.getBoundingClientRect();if(!r.width)return;const img=pad.drawn?c.toDataURL():null;c.width=r.width*2;c.height=r.height*2;const x=c.getContext('2d');x.lineWidth=4;x.lineCap='round';x.lineJoin='round';x.strokeStyle='#0a1a6b';if(img){const im=new Image();im.onload=()=>x.drawImage(im,0,0,c.width,c.height);im.src=img;}};
 fit();window.addEventListener('resize',fit);
 let down=false,last=null;
 const pos=e=>{const r=c.getBoundingClientRect();return[(e.clientX-r.left)*c.width/r.width,(e.clientY-r.top)*c.height/r.height]};
 c.addEventListener('pointerdown',e=>{down=true;last=pos(e);c.setPointerCapture(e.pointerId);e.preventDefault()});
 c.addEventListener('pointermove',e=>{if(!down)return;const p=pos(e),x=c.getContext('2d');x.beginPath();x.moveTo(last[0],last[1]);x.lineTo(p[0],p[1]);x.stroke();last=p;pad.drawn=true;e.preventDefault()});
 ['pointerup','pointercancel','pointerleave'].forEach(t=>c.addEventListener(t,()=>down=false));
 d.querySelector('button').onclick=()=>{c.getContext('2d').clearRect(0,0,c.width,c.height);pad.drawn=false};
}
function trimmed(c){const x=c.getContext('2d'),w=c.width,h=c.height,d=x.getImageData(0,0,w,h).data;let a=w,b=h,e=0,f=0;for(let y=0;y<h;y++)for(let X=0;X<w;X++)if(d[(y*w+X)*4+3]){if(X<a)a=X;if(X>e)e=X;if(y<b)b=y;if(y>f)f=y}
 if(e<a)return c.toDataURL('image/png');const o=document.createElement('canvas');o.width=e-a+10;o.height=f-b+10;o.getContext('2d').drawImage(c,a-5,b-5,o.width,o.height,0,0,o.width,o.height);return o.toDataURL('image/png')}
document.getElementById('go').onclick=async()=>{
 const m=document.getElementById('msg');m.className='err';
 const miss=pads.map((p,i)=>p.drawn?0:i+1).filter(Boolean);
 if(miss.length){m.textContent='Please sign page(s): '+miss.join(', ');pads[miss[0]-1].c.scrollIntoView({behavior:'smooth',block:'center'});return}
 const name=document.getElementById('name').value.trim(),email=document.getElementById('email').value.trim(),agree=document.getElementById('agree').checked;
 if(name.length<3){m.textContent='Enter your full name.';return}if(!/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email)){m.textContent='Enter a valid email.';return}if(!agree){m.textContent='Tick the agreement box.';return}
 const b=document.getElementById('go');b.disabled=true;b.textContent='Signing...';m.textContent='';
 try{const r=await fetch('/api/sign',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,email,agree,sigs:pads.map(p=>trimmed(p.c))})});const j=await r.json();
  if(!r.ok)throw new Error(j.error||'Error');
  const dn=document.getElementById('done');dn.style.display='block';dn.innerHTML='<h2 class="ok">Signed. Thank you.</h2><p>Document ID: <b>'+j.docId+'</b></p><p>The Pakistan Padel Federation has received your signed copy. Please download and keep your copy below.</p><p><a href="'+j.download+'">Download your signed PDF</a></p>';
  document.querySelectorAll('.card:not(#done),#pages').forEach(e=>e.style.display='none');window.scrollTo(0,0);
 }catch(e){m.textContent=e.message;b.disabled=false;b.textContent='Sign and submit'}};
</script></body></html>`;

app.listen(process.env.PORT || 10000, () => console.log('ppf-esign up', ORIGINAL_SHA));
