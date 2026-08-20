"use strict";

// ─── pptx — zero-dep PPTX OOXML constructor ───────────────────────────────────
//
// P-003 /deck: builds PPTX archives from in-memory slide specs without any
// npm dependency. PPTX is a ZIP of XML parts following the ECMA-376 spec; we
// emit uncompressed (STORE) entries so PowerPoint / Keynote / LibreOffice
// can parse without us pulling in a DEFLATE implementation.
//
// This module is intentionally minimal: it covers the 80% case of a
// product-narrative deck (title + body + bullets + footer) using a single
// blank layout. Animations, transitions, charts, tables, and embedded media
// are out of scope; reach for those via the open-design catalog (P-001).
//
// Public surface:
//   buildPptx({ slides, meta }) → Buffer
//
// `slides` is an array of:
//   { title, subtitle?, bullets?[], body?, notes?, layout? }
//
// `meta` is:
//   { title, author, company, subject }
//
// The returned Buffer is a complete, openable .pptx file.

const fs = require("node:fs");
const path = require("node:path");

// ─── ZIP writer (STORE / uncompressed) ───────────────────────────────────────

// CRC32 table (polynomial 0xEDB88320) — generated once on module load.
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(d = new Date()) {
  // DOS date/time encoding (2-second granularity for time).
  const date =
    ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  return { date: date & 0xffff, time: time & 0xffff };
}

// Build a single PPTX archive from { name, content } entries (string content
// gets utf-8 encoded). Returns a Buffer with the complete ZIP bytes.
function buildZip(entries) {
  const localChunks = [];
  const centralChunks = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, "utf8");
    const data = Buffer.isBuffer(entry.content)
      ? entry.content
      : Buffer.from(entry.content, "utf8");
    const crc = crc32(data);
    const { date, time } = dosDateTime(entry.date);

    // Local file header (30 bytes + name).
    const local = Buffer.alloc(30 + nameBytes.length);
    local.writeUInt32LE(0x04034b50, 0); // signature
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // general purpose flag — UTF-8 names
    local.writeUInt16LE(0, 8); // compression = store
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); // compressed size
    local.writeUInt32LE(data.length, 22); // uncompressed size
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28); // extra field length
    nameBytes.copy(local, 30);
    localChunks.push(local, data);

    // Central directory header (46 bytes + name).
    const central = Buffer.alloc(46 + nameBytes.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0x0800, 8); // flag
    central.writeUInt16LE(0, 10); // compression
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30); // extra field length
    central.writeUInt16LE(0, 32); // comment length
    central.writeUInt16LE(0, 34); // disk number start
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(offset, 42); // local header offset
    nameBytes.copy(central, 46);
    centralChunks.push(central);

    offset += local.length + data.length;
  }

  const cdSize = centralChunks.reduce((sum, b) => sum + b.length, 0);
  const cdOffset = offset;

  // End of central directory (22 bytes + comment).
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); // disk number
  eocd.writeUInt16LE(0, 6); // disk with CD start
  eocd.writeUInt16LE(entries.length, 8); // entries on this disk
  eocd.writeUInt16LE(entries.length, 10); // total entries
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdOffset, 16);
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...localChunks, ...centralChunks, eocd]);
}

// ─── XML escape ──────────────────────────────────────────────────────────────

function xmlEscape(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// ─── OOXML payload builders ──────────────────────────────────────────────────

const NAMESPACE_PRES =
  'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const NAMESPACE_A =
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"';
const NAMESPACE_R =
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const NAMESPACE_P14 =
  'xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main"';

function buildContentTypes(slideCount) {
  const slideOverrides = Array.from(
    { length: slideCount },
    (_, i) =>
      `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`,
  ).join("");

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
  <Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>
  <Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>
  <Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
  ${slideOverrides}
</Types>`;
}

function buildRootRels() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`;
}

function buildCoreProps(meta) {
  const now = new Date().toISOString();
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>${xmlEscape(meta.title || "Untitled")}</dc:title>
  <dc:creator>${xmlEscape(meta.author || "cortex-agent")}</dc:creator>
  <cp:lastModifiedBy>${xmlEscape(meta.author || "cortex-agent")}</cp:lastModifiedBy>
  <dc:subject>${xmlEscape(meta.subject || "")}</dc:subject>
  <cp:revision>1</cp:revision>
  <dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created>
  <dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified>
</cp:coreProperties>`;
}

function buildAppProps(slideCount, meta) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
  <Application>cortex-agent / P-003 /deck</Application>
  <Company>${xmlEscape(meta.company || "")}</Company>
  <Slides>${slideCount}</Slides>
</Properties>`;
}

function buildTheme() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Cortex Agent Default">
  <a:themeElements>
    <a:clrScheme name="Default">
      <a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>
      <a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>
      <a:dk2><a:srgbClr val="44546A"/></a:dk2>
      <a:lt2><a:srgbClr val="E7E6E6"/></a:lt2>
      <a:accent1><a:srgbClr val="5B9BD5"/></a:accent1>
      <a:accent2><a:srgbClr val="ED7D31"/></a:accent2>
      <a:accent3><a:srgbClr val="A5A5A5"/></a:accent3>
      <a:accent4><a:srgbClr val="FFC000"/></a:accent4>
      <a:accent5><a:srgbClr val="4472C4"/></a:accent5>
      <a:accent6><a:srgbClr val="70AD47"/></a:accent6>
      <a:hlink><a:srgbClr val="0563C1"/></a:hlink>
      <a:folHlink><a:srgbClr val="954F72"/></a:folHlink>
    </a:clrScheme>
    <a:fontScheme name="Default">
      <a:majorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont>
      <a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont>
    </a:fontScheme>
    <a:fmtScheme name="Default">
      <a:fillStyleLst>
        <a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
        <a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
        <a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
      </a:fillStyleLst>
      <a:lnStyleLst>
        <a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>
        <a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>
        <a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>
      </a:lnStyleLst>
      <a:effectStyleLst>
        <a:effectStyle><a:effectLst/></a:effectStyle>
        <a:effectStyle><a:effectLst/></a:effectStyle>
        <a:effectStyle><a:effectLst/></a:effectStyle>
      </a:effectStyleLst>
      <a:bgFillStyleLst>
        <a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
        <a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
        <a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
      </a:bgFillStyleLst>
    </a:fmtScheme>
  </a:themeElements>
</a:theme>`;
}

function buildSlideMaster() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldMaster ${NAMESPACE_PRES} ${NAMESPACE_A} ${NAMESPACE_R}>
  <p:cSld><p:spTree>
    <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
    <p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
  </p:spTree></p:cSld>
  <p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>
  <p:sldLayoutIdLst><p:sldLayoutId id="1" r:id="rId1"/></p:sldLayoutIdLst>
</p:sldMaster>`;
}

function buildSlideMasterRels() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/>
</Relationships>`;
}

function buildSlideLayout() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldLayout ${NAMESPACE_PRES} ${NAMESPACE_A} ${NAMESPACE_R} type="blank" preserve="1">
  <p:cSld name="Blank"><p:spTree>
    <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
    <p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
  </p:spTree></p:cSld>
</p:sldLayout>`;
}

function buildSlideLayoutRels() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/>
</Relationships>`;
}

function buildPresentation(slideCount) {
  const slideRefs = Array.from(
    { length: slideCount },
    (_, i) =>
      `<p:sldId id="${256 + i}" r:id="rId${i + 1}"/>`,
  ).join("\n    ");
  const slideRels = Array.from(
    { length: slideCount },
    (_, i) =>
      `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i + 1}.xml"/>`,
  ).join("\n  ");

  return {
    presentation: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation ${NAMESPACE_PRES} ${NAMESPACE_A} ${NAMESPACE_R} ${NAMESPACE_P14}>
  <p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId${slideCount + 1}"/></p:sldMasterIdLst>
  <p:sldIdLst>
    ${slideRefs}
  </p:sldIdLst>
  <p:sldSz cx="12192000" cy="6858000"/>
  <p:notesSz cx="6858000" cy="9144000"/>
</p:presentation>`,
    presentationRels: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  ${slideRels}
  <Relationship Id="rId${slideCount + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>
</Relationships>`,
  };
}

// Build a single slide (16:9, default font). Text-only via `<p:sp>` shapes.
function buildSlide(slide, index) {
  const shapes = [];

  // Title shape (always present).
  shapes.push(`<p:sp>
    <p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>
    <p:spPr><a:xfrm><a:off x="457200" y="457200"/><a:ext cx="11277600" cy="914400"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr>
    <p:txBody>
      <a:bodyPr wrap="square" rtlCol="0" anchor="b"/><a:lstStyle/>
      <a:p><a:pPr algn="l"/><a:r><a:rPr lang="en-US" sz="4400" b="1"/><a:t>${xmlEscape(slide.title || "")}</a:t></a:r></a:p>
    </p:txBody>
  </p:sp>`);

  // Subtitle (if present).
  if (slide.subtitle) {
    shapes.push(`<p:sp>
      <p:nvSpPr><p:cNvPr id="3" name="Subtitle"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>
      <p:spPr><a:xfrm><a:off x="457200" y="1450000"/><a:ext cx="11277600" cy="600000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr>
      <p:txBody>
        <a:bodyPr wrap="square" rtlCol="0" anchor="t"/><a:lstStyle/>
        <a:p><a:pPr algn="l"/><a:r><a:rPr lang="en-US" sz="2400"/><a:t>${xmlEscape(slide.subtitle)}</a:t></a:r></a:p>
      </p:txBody>
    </p:sp>`);
  }

  // Bullet list (if present).
  if (Array.isArray(slide.bullets) && slide.bullets.length > 0) {
    const bulletParas = slide.bullets
      .map(
        (b) => `<a:p><a:pPr marL="285750" indent="-285750"><a:buFont typeface="Arial" panose="020B0604020202020204" pitchFamily="34" charset="0"/><a:buChar char="•"/></a:pPr><a:r><a:rPr lang="en-US" sz="2000"/><a:t>${xmlEscape(b)}</a:t></a:r></a:p>`,
      )
      .join("");
    const top = slide.subtitle ? 2150000 : 1500000;
    shapes.push(`<p:sp>
      <p:nvSpPr><p:cNvPr id="4" name="Bullets"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>
      <p:spPr><a:xfrm><a:off x="685800" y="${top}"/><a:ext cx="10800000" cy="${4500000 - top + 600000}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr>
      <p:txBody>
        <a:bodyPr wrap="square" rtlCol="0" anchor="t"/><a:lstStyle/>
        ${bulletParas}
      </p:txBody>
    </p:sp>`);
  } else if (slide.body) {
    // Body paragraph fallback.
    const top = slide.subtitle ? 2150000 : 1500000;
    shapes.push(`<p:sp>
      <p:nvSpPr><p:cNvPr id="4" name="Body"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>
      <p:spPr><a:xfrm><a:off x="685800" y="${top}"/><a:ext cx="10800000" cy="4500000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr>
      <p:txBody>
        <a:bodyPr wrap="square" rtlCol="0" anchor="t"/><a:lstStyle/>
        <a:p><a:pPr algn="l"/><a:r><a:rPr lang="en-US" sz="2000"/><a:t>${xmlEscape(slide.body)}</a:t></a:r></a:p>
      </p:txBody>
    </p:sp>`);
  }

  // Slide notes (if provided).
  const notesBlock = slide.notes
    ? `<p:notes ${NAMESPACE_PRES} ${NAMESPACE_A} ${NAMESPACE_R}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr><p:sp><p:nvSpPr><p:cNvPr id="2" name="Notes"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="685800" y="4350000"/><a:ext cx="6000000" cy="1500000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US" sz="1200"/><a:t>${xmlEscape(slide.notes)}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:notes>`
    : "";

  return {
    slide: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld ${NAMESPACE_PRES} ${NAMESPACE_A} ${NAMESPACE_R} ${NAMESPACE_P14}>
  <p:cSld><p:spTree>
    <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
    <p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
    ${shapes.join("\n    ")}
  </p:spTree></p:cSld>
  ${notesBlock ? `<p:notesBlRef>${""}</p:notesBlRef>` : ""}
</p:sld>`,
    notes: notesBlock,
    notesRels: notesBlock
      ? `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="../slides/slide${index + 1}.xml"/>
</Relationships>`
      : null,
  };
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Build a PPTX archive from in-memory slide specs.
 * @param {{ slides: Array<object>, meta?: object }} opts
 * @returns {Buffer}
 */
function buildPptx(opts) {
  const slides = Array.isArray(opts && opts.slides) ? opts.slides : [];
  if (slides.length === 0) {
    throw new Error("buildPptx: at least one slide is required");
  }
  const meta = (opts && opts.meta) || {};
  const date = new Date();

  const entries = [];
  entries.push({ name: "[Content_Types].xml", content: buildContentTypes(slides.length), date });
  entries.push({ name: "_rels/.rels", content: buildRootRels(), date });
  entries.push({ name: "docProps/core.xml", content: buildCoreProps(meta), date });
  entries.push({ name: "docProps/app.xml", content: buildAppProps(slides.length, meta), date });
  entries.push({ name: "ppt/theme/theme1.xml", content: buildTheme(), date });
  entries.push({ name: "ppt/slideMasters/slideMaster1.xml", content: buildSlideMaster(), date });
  entries.push({ name: "ppt/slideMasters/_rels/slideMaster1.xml.rels", content: buildSlideMasterRels(), date });
  entries.push({ name: "ppt/slideLayouts/slideLayout1.xml", content: buildSlideLayout(), date });
  entries.push({ name: "ppt/slideLayouts/_rels/slideLayout1.xml.rels", content: buildSlideLayoutRels(), date });

  const { presentation, presentationRels } = buildPresentation(slides.length);
  entries.push({ name: "ppt/presentation.xml", content: presentation, date });
  entries.push({ name: "ppt/_rels/presentation.xml.rels", content: presentationRels, date });

  slides.forEach((slide, i) => {
    const built = buildSlide(slide, i);
    entries.push({ name: `ppt/slides/slide${i + 1}.xml`, content: built.slide, date });
    entries.push({
      name: `ppt/slides/_rels/slide${i + 1}.xml.rels`,
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
</Relationships>`,
      date,
    });
    if (built.notes) {
      entries.push({ name: `ppt/notesSlides/notesSlide${i + 1}.xml`, content: built.notes, date });
    }
  });

  return buildZip(entries);
}

// ─── Diagnostics ─────────────────────────────────────────────────────────────

/** Smoke test: write a tiny PPTX to a temp path and return its byte size. */
function writeSmokeFile(targetPath) {
  const buffer = buildPptx({
    slides: [
      { title: "Smoke", subtitle: "Test", bullets: ["One", "Two"] },
    ],
    meta: { title: "Smoke", author: "cortex-agent" },
  });
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, buffer);
  return { size: buffer.length, path: targetPath };
}

module.exports = {
  buildPptx,
  buildZip,
  crc32,
  // exposed for tests
  _internal: {
    buildContentTypes,
    buildRootRels,
    buildCoreProps,
    buildAppProps,
    buildTheme,
    buildSlideMaster,
    buildSlideLayout,
    buildPresentation,
    buildSlide,
  },
  writeSmokeFile,
};