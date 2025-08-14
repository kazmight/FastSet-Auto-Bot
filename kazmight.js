// index.js — FastSet Testnet + CryptoBotUI (ESM)
import fs from "fs";
import path from "path";
import axios from "axios";
import { v4 as uuidv4 } from "uuid";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import { createInterface } from "readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { createRequire } from "module";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// === Import UI (CommonJS) ===
const require = createRequire(import.meta.url);
const { CryptoBotUI } = require("./ui.js");

// === Konfigurasi API & default ===
const API_BASE = "https://wallet.fastset.xyz/api/";
let SENDS_PER_ACCOUNT = parseInt(process.env.SENDS_PER_ACCOUNT || "1", 10);
let DELAY_SECONDS = parseInt(process.env.DELAY_SECONDS || "5", 10);

// === Token testnet ===
const tokens = [
  { name: "SET", tokenId: "Internal-FastSet", decimals: 0, faucetAmount: "98686" },
  { name: "USDC", tokenId: "ReFosxqpCeJTBuJXJOSoAFE8F4+fXpftTJBYs8qAaeI=", decimals: 6, faucetAmount: "1000000000" },
  { name: "ETH", tokenId: "webWlA8UWwxnPc+awV0isStdDwYyynDf+eoh3ezEzWc=", decimals: 18, faucetAmount: "3140000000000000000" },
  { name: "SOL", tokenId: "2EJhDfYD4V39bKTVgJUhEd0LAs3VUAfEiGRucXc9eHU=", decimals: 9, faucetAmount: "100000000000" },
  { name: "BTC", tokenId: "/NHeobovw7GeS14wseW3RmvFRQIojkfWEGG+0HaIPtE=", decimals: 8, faucetAmount: "100000000" }
];

const sendRanges = {
  SET: { min: 1, max: 10 },
  USDC: { min: 0.02, max: 0.045 },
  ETH: { min: 0.0003, max: 0.00075 },
  SOL: { min: 0.0003, max: 0.00075 },
  BTC: { min: 0.000003, max: 0.0000075 }
};

// === Bech32 decode (tanpa verifikasi checksum) ===
const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
function from5to8(data) {
  let acc = 0n, bits = 0; const out = []; const maxv = (1 << 8) - 1;
  for (const v of data) { acc = (acc << 5n) | BigInt(v); bits += 5;
    while (bits >= 8) { bits -= 8; out.push(Number((acc >> BigInt(bits)) & BigInt(maxv))); } }
  if (bits >= 5 || Number(acc & ((1n << BigInt(bits)) - 1n)) !== 0) throw new Error("Padding error");
  return Buffer.from(out);
}
function decodeBech32WithoutVerify(address) {
  const lower = address.toLowerCase();
  const pos = lower.lastIndexOf("1");
  if (pos < 1 || pos + 7 > lower.length) throw new Error("Invalid bech32");
  const dataStr = lower.slice(pos + 1);
  const data = [];
  for (const c of dataStr) {
    const idx = CHARSET.indexOf(c);
    if (idx === -1) throw new Error("Invalid char");
    data.push(idx);
  }
  const publicBytes = from5to8(data.slice(0, -6));
  return { publicBytes };
}

// === Helpers ===
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const randFloat = (min, max) => Math.random() * (max - min) + min;
const short = (s) => (s ? s.slice(0, 6) + "..." + s.slice(-4) : "N/A");

async function createAgent(proxyUrl) {
  if (!proxyUrl) return undefined;
  try {
    if (proxyUrl.startsWith("socks")) {
      const { SocksProxyAgent } = await import("socks-proxy-agent");
      return new SocksProxyAgent(proxyUrl);
    } else {
      const { HttpsProxyAgent } = await import("https-proxy-agent");
      return new HttpsProxyAgent(proxyUrl);
    }
  } catch {
    ui?.log?.("info", `Proxy module not available. Continue without proxy.`);
    return undefined;
  }
}

async function makeApiCall(method, payload, { proxyUrl } = {}) {
  const id = uuidv4();
  const agent = await createAgent(proxyUrl || null);
  const res = await axios.post(API_BASE + method, payload, {
    headers: { "Content-Type": "application/json", "X-Req-Id": id },
    httpsAgent: agent
  });
  if (res.status !== 200) {
    const msg = typeof res.data === "object" ? JSON.stringify(res.data) : String(res.data);
    throw new Error(`API ${method} -> ${res.status}: ${msg}`);
  }
  return res.data;
}

// === Account dari .env ===
function buildAccount(privateKeyHex, bech32Address) {
  if (!/^[0-9a-fA-F]{64}$/.test(privateKeyHex)) throw new Error("PRIVATE_KEYS must be 64-hex per key (32 bytes)");
  const privateBytes = Buffer.from(privateKeyHex, "hex");
  const { publicBytes } = decodeBech32WithoutVerify(bech32Address);
  const sender = publicBytes.toString("base64");       // 44 chars
  const key = Buffer.concat([privateBytes, publicBytes]).toString("base64"); // 88 chars
  return { privateKeyHex, address: bech32Address, sender, key };
}
function loadAccountsFromEnv() {
  const keys = (process.env.PRIVATE_KEYS || "").split(",").map(s => s.trim()).filter(Boolean);
  const addrs = (process.env.ADDRESSES || "").split(",").map(s => s.trim()).filter(Boolean);
  if (!keys.length || !addrs.length) throw new Error("Set PRIVATE_KEYS dan ADDRESSES di .env (comma-separated).");
  if (keys.length !== addrs.length) throw new Error(`PRIVATE_KEYS (${keys.length}) != ADDRESSES (${addrs.length}).`);
  return keys.map((k, i) => buildAccount(k, addrs[i]));
}
function loadRecipients(file = "wallet.txt") {
  const p = path.resolve(__dirname, file);
  if (!fs.existsSync(p)) throw new Error(`wallet.txt not found at ${p}`);
  return fs.readFileSync(p, "utf8").split(/\r?\n/).map(s => s.trim()).filter(Boolean);
}
function loadProxies() {
  if (process.env.PROXIES) return process.env.PROXIES.split(",").map(s => s.trim()).filter(Boolean);
  const p = path.resolve(__dirname, "proxy.txt");
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, "utf8").split(/\r?\n/).map(s => s.trim()).filter(Boolean);
}

// === Faucet & Transfer ===
async function dripFaucet(account, token, opts = {}) {
  const sender = account.sender;
  const payload = {
    sender,
    info: {
      recipient: sender,
      amount: token.faucetAmount,
      tokenId: token.tokenId !== "Internal-FastSet" ? token.tokenId : undefined
    }
  };
  if (token.tokenId === "Internal-FastSet") delete payload.info.tokenId;
  await makeApiCall(token.tokenId === "Internal-FastSet" ? "dripBalance" : "dripToken", payload, opts);
  ui.log("success", `Faucet ${token.name} claimed: ${token.faucetAmount}`);
}

async function performSend(account, token, amountHuman, { recipients, ownAddresses = [], proxyUrl } = {}) {
  if (!recipients?.length) throw new Error("No recipients loaded");

  // pilih random recipient != own
  let to;
  for (let guard = 0; guard < 1000; guard++) {
    const cand = recipients[Math.floor(Math.random() * recipients.length)];
    if (!ownAddresses.includes(cand)) { to = cand; break; }
  }
  if (!to) throw new Error("Unable to pick recipient different from own addresses");

  // bech32 -> base64
  const { publicBytes } = decodeBech32WithoutVerify(to);
  const recipient = publicBytes.toString("base64");
  const sender = account.sender;
  const key = account.key;
  const amount = (BigInt(Math.floor(parseFloat(amountHuman) * 10 ** token.decimals))).toString();

  ui.log("pending", `Preparing ${amountHuman} ${token.name} -> ${short(to)}`);

  // cek saldo
  const info = await makeApiCall("getAccountInfo", { sender }, { proxyUrl });
  const nextNonce = info.nextNonce;
  let bal = token.tokenId === "Internal-FastSet"
    ? BigInt(info.balance)
    : BigInt(info.tokenBalances?.[token.tokenId] || 0);

  if (bal < BigInt(amount)) {
    ui.log("warning", `Saldo ${token.name} kurang. Claim faucet...`);
    await dripFaucet(account, token, { proxyUrl });
    await sleep(5000);
    const upd = await makeApiCall("getAccountInfo", { sender }, { proxyUrl });
    bal = token.tokenId === "Internal-FastSet"
      ? BigInt(upd.balance)
      : BigInt(upd.tokenBalances?.[token.tokenId] || 0);
    if (bal < BigInt(amount)) throw new Error("Faucet claim failed or insufficient.");
  }

  const payload = {
    sender, key, nextNonce,
    transferInfo: {
      recipient, amount,
      tokenId: token.tokenId !== "Internal-FastSet" ? token.tokenId : undefined
    }
  };
  const method = token.tokenId === "Internal-FastSet" ? "transferBalance" : "transferToken";
  if (method === "transferBalance") delete payload.transferInfo.tokenId;

  await makeApiCall(method, payload, { proxyUrl });
  ui.log("success", `Sent ${amountHuman} ${token.name} -> ${short(to)}`);
  return to;
}

// === UI Instance ===
const ui = new CryptoBotUI({
  title: "FASTSET TESTNET • INVictusLabs",
  menuItems: [
    "1. Mulai Transaksi",
    "2. Ubah Param (Jumlah & Delay)",
    "3. Reload wallet.txt",
    "4. Tampilkan Saldo",
    "5. Clear Logs",
    "6. Exit"
  ],
  tickerText1: "UOMI TESTNET",
  tickerText2: "Join Telegram Channel : Invictuslabs - Airdrops",
  nativeSymbol: "SET",
  logFile: process.env.LOG_FILE || "transactions.log",
  mirrorConsole: true
});

// === Sinkronisasi UI: wallet & token ===
async function refreshBalancesFor(account, { proxyUrl } = {}) {
  try {
    const info = await makeApiCall("getAccountInfo", { sender: account.sender }, { proxyUrl });
    const setBal = BigInt(info.balance).toString();

    const tbal = (tid, dec) => {
      const raw = BigInt(info.tokenBalances?.[tid] || 0);
      if (dec === 0) return raw.toString();
      const n = Number(raw) / (10 ** dec);
      return n.toFixed(Math.min(6, dec));
    };

    const displayTokens = [
      { enabled: true, name: "SET", symbol: "SET", balance: setBal },
      { enabled: true, name: "USDC", symbol: "USDC", balance: tbal(tokens[1].tokenId, tokens[1].decimals) },
      { enabled: true, name: "ETH",  symbol: "ETH",  balance: tbal(tokens[2].tokenId, tokens[2].decimals) },
      { enabled: true, name: "SOL",  symbol: "SOL",  balance: tbal(tokens[3].tokenId, tokens[3].decimals) },
      { enabled: true, name: "BTC",  symbol: "BTC",  balance: tbal(tokens[4].tokenId, tokens[4].decimals) }
    ];

    ui.updateWallet({
      address: account.address,
      nativeBalance: setBal,
      network: "FastSet Testnet",
      gasPrice: "-",
      nonce: String(info.nextNonce ?? "-")
    });
    ui.setTokens(displayTokens);
  } catch (e) {
    ui.log("error", `Gagal ambil saldo: ${e.message}`);
  }
}

// === Prompt param ===
async function promptParams() {
  const rl = createInterface({ input, output });
  try {
    const c = await rl.question(`Jumlah transaksi per akun? (Enter=${SENDS_PER_ACCOUNT}): `);
    const d = await rl.question(`Delay antar transaksi (detik)? (Enter=${DELAY_SECONDS}): `);
    const count = c.trim() === "" ? SENDS_PER_ACCOUNT : parseInt(c.trim(), 10);
    const delay = d.trim() === "" ? DELAY_SECONDS : parseInt(d.trim(), 10);
    if (Number.isInteger(count) && count > 0) SENDS_PER_ACCOUNT = count; else ui.log("warning", "Jumlah tidak valid, pakai default.");
    if (Number.isInteger(delay) && delay >= 0) DELAY_SECONDS = delay; else ui.log("warning", "Delay tidak valid, pakai default.");
  } finally { await rl.close(); }
}

// === Runner Transaksi (per batch, kembali ke menu saat selesai) ===
async function runBatch({ accounts, recipients, proxies, ownAddresses }) {
  ui.setActive(true);
  ui.updateStats({ pendingTx: 0 });
  let ok = 0, fail = 0, total = 0;

  for (let i = 0; i < accounts.length; i++) {
    const acc = accounts[i];
    const proxyUrl = proxies.length ? proxies[i % proxies.length] : undefined;

    ui.log("info", `== Account #${i + 1}: ${short(acc.address)} ${proxyUrl ? `(proxy)` : ""} ==`);
    await refreshBalancesFor(acc, { proxyUrl });

    for (let s = 0; s < SENDS_PER_ACCOUNT; s++) {
      total++;
      const token = tokens[Math.floor(Math.random() * tokens.length)];
      const r = sendRanges[token.name];
      const maxDecimals = Math.min(6, token.decimals);
      const amountHuman = randFloat(r.min, r.max).toFixed(maxDecimals);

      try {
        ui.updateStats({ pendingTx: (ui.pendingTx || 0) + 1 });
        await performSend(acc, token, amountHuman, { recipients, ownAddresses, proxyUrl });
        ok++;
      } catch (err) {
        ui.log("error", `Tx gagal: ${err.message}`);
        fail++;
      } finally {
        ui.updateStats({ pendingTx: Math.max(0, (ui.pendingTx || 1) - 1) });
      }

      // update stats & saldo
      ui.updateStats({
        transactionCount: (ui.transactionCount || 0) + 1,
        failedTx: fail,
        successRate: total ? (100 * (ok / total)) : 100
      });
      await refreshBalancesFor(acc, { proxyUrl });

      if (s < SENDS_PER_ACCOUNT - 1 && DELAY_SECONDS > 0) {
        ui.log("pending", `Delay ${DELAY_SECONDS}s before next send...`);
        await sleep(DELAY_SECONDS * 1000);
      }
    }

    if (i < accounts.length - 1) {
      ui.log("pending", `Next account in 10s...`);
      await sleep(10_000);
    }
  }

  ui.log("completed", `Selesai batch. OK=${ok}, FAIL=${fail}, TOTAL=${total}`);
  ui.setActive(false);
}

// === Main & Menu ===
let accounts = [];
let recipients = [];
let proxies = [];
let ownAddresses = [];

async function init() {
  try {
    accounts = loadAccountsFromEnv();
    recipients = loadRecipients("wallet.txt");
    proxies = loadProxies();
    ownAddresses = (process.env.ADDRESSES || "").split(",").map(s => s.trim()).filter(Boolean);

    ui.log("success", `Loaded ${accounts.length} account(s) from .env`);
    ui.log("success", `Loaded ${recipients.length} recipient(s) from wallet.txt`);
    if (proxies.length) ui.log("info", `Loaded ${proxies.length} proxy(ies)`);

    // tampilkan saldo akun pertama saat start
    await refreshBalancesFor(accounts[0], { proxyUrl: proxies[0] });

  } catch (e) {
    ui.log("error", e.message);
  }
}

ui.on("menu:select", async (label) => {
  const plain = label.toLowerCase();
  try {
    if (plain.startsWith("1.")) {
      await runBatch({ accounts, recipients, proxies, ownAddresses });
    } else if (plain.startsWith("2.")) {
      await promptParams();
      ui.log("success", `Param di-set: ${SENDS_PER_ACCOUNT} tx/akun, delay ${DELAY_SECONDS}s`);
    } else if (plain.startsWith("3.")) {
      try {
        recipients = loadRecipients("wallet.txt");
        ui.log("success", `wallet.txt reloaded. ${recipients.length} recipient(s).`);
      } catch (e) { ui.log("error", e.message); }
    } else if (plain.startsWith("4.")) {
      await refreshBalancesFor(accounts[0], { proxyUrl: proxies[0] });
    } else if (plain.startsWith("5.")) {
      ui.clearLogs();
      ui.log("info", "Logs cleared.");
    } else if (plain.startsWith("6.") || plain.includes("exit")) {
      ui.destroy(0);
    } else {
      ui.log("warning", "Menu tidak dikenal.");
    }
  } catch (e) {
    ui.log("error", e.message);
  }
});

await init();
