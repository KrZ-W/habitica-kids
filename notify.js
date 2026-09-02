/*
 * Notifications for habitica-kids — dependency-free.
 *
 * Two delivery methods:
 *   sendmail : pipe to the local /usr/sbin/sendmail (zero config, but delivery
 *              to big providers from a home IP is often rejected/spam-filed)
 *   smtp     : talk SMTP to a real relay (host/port/user/pass) — reliable
 */
const { spawn } = require("child_process");
const net = require("net");
const tls = require("tls");

function viaSendmail(from, to, subject, body) {
  return new Promise((resolve, reject) => {
    const msg =
      `From: ${from}\r\nTo: ${to}\r\nSubject: ${subject}\r\n` +
      `MIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}\r\n`;
    const p = spawn("/usr/sbin/sendmail", ["-t", "-oi"]);
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error("sendmail exit " + code))));
    p.stdin.end(msg);
  });
}

// Minimal SMTP: EHLO → (STARTTLS) → AUTH LOGIN → MAIL/RCPT/DATA
function viaSmtp(cfg, from, to, subject, body) {
  return new Promise((resolve, reject) => {
    const port = cfg.port || (cfg.secure ? 465 : 587);
    let sock = cfg.secure
      ? tls.connect({ host: cfg.host, port, servername: cfg.host })
      : net.connect({ host: cfg.host, port });
    let buf = "";
    let step = 0;
    let done = false;

    const fail = (e) => { if (!done) { done = true; try { sock.destroy(); } catch (_) {} reject(e instanceof Error ? e : new Error(String(e))); } };
    const finish = () => { if (!done) { done = true; try { sock.end(); } catch (_) {} resolve(); } };
    const send = (line) => sock.write(line + "\r\n");
    const b64 = (s) => Buffer.from(String(s), "utf8").toString("base64");

    const headers =
      `From: ${from}\r\nTo: ${to}\r\nSubject: ${subject}\r\n` +
      `MIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n`;
    const data = (headers + body).replace(/\r?\n\./g, "\r\n..") + "\r\n.";

    const onData = (chunk) => {
      buf += chunk.toString("utf8");
      let idx;
      while ((idx = buf.indexOf("\r\n")) !== -1) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        if (/^\d{3}-/.test(line)) continue; // multiline continuation
        const code = parseInt(line.slice(0, 3), 10);
        if (code >= 400) return fail(new Error("SMTP " + line));
        switch (step) {
          case 0: step = 1; send("EHLO habitica-kids"); break;
          case 1:
            if (!cfg.secure && cfg.starttls !== false) { step = 2; send("STARTTLS"); }
            else { step = 3; send("AUTH LOGIN"); }
            break;
          case 2: { // upgrade
            sock.removeListener("data", onData);
            const plain = sock;
            sock = tls.connect({ socket: plain, servername: cfg.host }, () => {
              step = 1.5; sock.write("EHLO habitica-kids\r\n");
            });
            sock.on("data", onData); sock.on("error", fail);
            return;
          }
          case 1.5: step = 3; send("AUTH LOGIN"); break;
          case 3: step = 4; send(b64(cfg.user)); break;
          case 4: step = 5; send(b64(cfg.pass)); break;
          case 5: step = 6; send(`MAIL FROM:<${from}>`); break;
          case 6: step = 7; send(`RCPT TO:<${to}>`); break;
          case 7: step = 8; send("DATA"); break;
          case 8: step = 9; sock.write(data + "\r\n"); break;
          case 9: step = 10; send("QUIT"); break;
          default: return finish();
        }
      }
    };
    sock.on("data", onData);
    sock.on("error", fail);
    sock.setTimeout(15000, () => fail(new Error("SMTP timeout")));
  });
}

async function sendMail(cfg, subject, body) {
  if (!cfg || !cfg.to) return;
  const from = cfg.from || "habitica-kids@localhost";
  if (cfg.method === "smtp" && cfg.smtp && cfg.smtp.host) {
    return viaSmtp(cfg.smtp, from, cfg.to, subject, body);
  }
  return viaSendmail(from, cfg.to, subject, body);
}

module.exports = { sendMail };
