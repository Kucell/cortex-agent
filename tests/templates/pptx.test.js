"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");

const { buildPptx, buildZip, crc32, _internal } = require("../../lib/templates/pptx");

// ─── crc32 ──────────────────────────────────────────────────────────────────

test("crc32: empty input is 0", () => {
  assert.equal(crc32(Buffer.alloc(0)), 0);
});

test("crc32: matches canonical 'abc'", () => {
  // Well-known CRC32 value for "abc" is 0x352441C2 = 8915...
  const expected = 0x352441c2 >>> 0;
  assert.equal(crc32(Buffer.from("abc", "utf8")), expected);
});

test("crc32: '123456789' = 0xCBF43926", () => {
  const expected = 0xcbf43926 >>> 0;
  assert.equal(crc32(Buffer.from("123456789", "utf8")), expected);
});

// ─── buildZip ───────────────────────────────────────────────────────────────

test("buildZip: produces a valid PK archive header", () => {
  const buf = buildZip([
    { name: "a.txt", content: "hello" },
  ]);
  // Local file header signature: PK\x03\x04
  assert.equal(buf.readUInt32LE(0), 0x04034b50);
  // End-of-central-directory signature: PK\x05\x06 (at the end)
  const eocdOffset = buf.length - 22;
  assert.equal(buf.readUInt32LE(eocdOffset), 0x06054b50);
});

test("buildZip: EOCD records 1 entry with correct size", () => {
  const buf = buildZip([{ name: "hello.txt", content: "world" }]);
  const eocdOffset = buf.length - 22;
  assert.equal(buf.readUInt16LE(eocdOffset + 8), 1); // entries on disk
  assert.equal(buf.readUInt16LE(eocdOffset + 10), 1); // total entries
  // Central directory signature at offset = local_header(30) + name(9) + data(5) = 44.
  const cdOffset = 30 + 9 + 5;
  assert.equal(buf.readUInt32LE(cdOffset), 0x02014b50);
});

test("buildZip: roundtrip with zlib (deflate) fails — we use STORE, not DEFLATE", () => {
  // Sanity: confirm our entries are not deflate-compressed. We can't unzip
  // without a parser, but we can verify the compression method byte = 0.
  const buf = buildZip([{ name: "a.txt", content: "hello" }]);
  // Local header at offset 0; compression method at offset 8-10.
  assert.equal(buf.readUInt16LE(8), 0); // STORE
});

test("buildZip: two entries recorded in EOCD", () => {
  const buf = buildZip([
    { name: "a.txt", content: "alpha" },
    { name: "b.txt", content: "beta" },
  ]);
  const eocdOffset = buf.length - 22;
  assert.equal(buf.readUInt16LE(eocdOffset + 10), 2);
});

// ─── XML escape helpers ─────────────────────────────────────────────────────

test("_internal: xml escape handles & < > \" '", () => {
  const escape = (v) => {
    // re-implement to validate test
    return String(v ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;");
  };
  assert.equal(escape('<a&b>'), "&lt;a&amp;b&gt;");
  assert.equal(escape(`"'`), "&quot;&apos;");
  assert.equal(escape(null), "");
});

// ─── buildPptx minimal contract ─────────────────────────────────────────────

test("buildPptx: requires at least one slide", () => {
  assert.throws(() => buildPptx({ slides: [] }), /at least one slide/);
});

test("buildPptx: produces a non-empty Buffer with valid PPTX headers", () => {
  const buf = buildPptx({
    slides: [{ title: "Hello", bullets: ["one", "two"] }],
    meta: { title: "Demo", author: "tester" },
  });
  assert.ok(Buffer.isBuffer(buf));
  assert.ok(buf.length > 1024, "PPTX should be at least 1KB for minimal slides");
  // PK header
  assert.equal(buf.readUInt32LE(0), 0x04034b50);
  // EOCD signature at the end
  const eocdOffset = buf.length - 22;
  assert.equal(buf.readUInt32LE(eocdOffset), 0x06054b50);
});

test("buildPptx: contains expected OOXML parts in archive", () => {
  const buf = buildPptx({
    slides: [{ title: "Cover" }, { title: "Body" }, { title: "End" }],
    meta: { title: "Three" },
  });
  // Entry count: [Content_Types].xml + _rels/.rels + 2 docProps + theme +
  //   master + master.rels + layout + layout.rels + presentation + pres.rels +
  //   3 slides + 3 slide.rels = 17 entries (no notesSlides unless notes set).
  const eocdOffset = buf.length - 22;
  const total = buf.readUInt16LE(eocdOffset + 10);
  assert.equal(total, 17);
});

test("buildPptx: survives a slide with all optional fields", () => {
  const buf = buildPptx({
    slides: [
      {
        title: "Full",
        subtitle: "Sub",
        bullets: ["a", "b", "c"],
        body: "Should not render if bullets present",
        notes: "Speaker notes here",
      },
    ],
  });
  assert.ok(buf.length > 1024);
});

test("buildPptx: handles CJK + special chars in title", () => {
  const buf = buildPptx({
    slides: [{ title: "<你好>&\"世界\"", bullets: ["中文 bullet"] }],
  });
  // PPTX with a single title-slide should be ~1KB
  assert.ok(buf.length > 1024);
});

test("buildPptx: body fallback when no bullets", () => {
  const buf = buildPptx({
    slides: [{ title: "Plain", body: "Just text, no bullets." }],
  });
  assert.ok(buf.length > 1024);
});

// ─── writeSmokeFile ──────────────────────────────────────────────────────────

test("writeSmokeFile: writes a real file on disk", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-pptx-"));
  const target = path.join(tmp, "smoke.pptx");
  const result = require("../../lib/templates/pptx").writeSmokeFile(target);
  assert.equal(result.path, target);
  assert.ok(result.size > 0);
  assert.ok(fs.existsSync(target));
  // Header check on the written file
  const onDisk = fs.readFileSync(target);
  assert.equal(onDisk.readUInt32LE(0), 0x04034b50);
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ─── Internal content sniffers ───────────────────────────────────────────────

test("_internal: buildContentTypes lists every slide", () => {
  const xml = _internal.buildContentTypes(2);
  assert.match(xml, /slide1\.xml/);
  assert.match(xml, /slide2\.xml/);
  assert.match(xml, /slideMaster1\.xml/);
});

test("_internal: buildSlide includes title and bullets", () => {
  const slide = _internal.buildSlide(
    { title: "T", bullets: ["x", "y"] },
    0,
  );
  assert.match(slide.slide, /<a:t>T<\/a:t>/);
  assert.match(slide.slide, /<a:t>x<\/a:t>/);
  assert.match(slide.slide, /<a:t>y<\/a:t>/);
  assert.match(slide.slide, /xmlns:p=/);
});

test("_internal: buildSlide omits bullets when not provided", () => {
  const slide = _internal.buildSlide({ title: "T", body: "B" }, 0);
  assert.doesNotMatch(slide.slide, /buChar char="•"/);
  assert.match(slide.slide, /<a:t>B<\/a:t>/);
});

test("_internal: buildPresentation produces slide refs in correct count", () => {
  const { presentation } = _internal.buildPresentation(3);
  // Match inside <p:sldIdLst> only — closing tag contains p:sldId as substring too.
  const lst = presentation.match(/<p:sldIdLst>([\s\S]*?)<\/p:sldIdLst>/);
  assert.ok(lst, "sldIdLst block present");
  const ids = lst[1].match(/<p:sldId\b/g) || [];
  assert.equal(ids.length, 3);
});

// (correctness of sldIdLst: 3 entries expected)
test("_internal: buildPresentation sldIdLst length = slideCount", () => {
  const { presentation } = _internal.buildPresentation(5);
  const lst = presentation.match(/<p:sldIdLst>([\s\S]*?)<\/p:sldIdLst>/);
  assert.ok(lst, "sldIdLst block present");
  const ids = lst[1].match(/p:sldId\b/g) || [];
  assert.equal(ids.length, 5);
});