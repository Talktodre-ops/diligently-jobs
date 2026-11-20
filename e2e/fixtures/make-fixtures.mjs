// Writes the sample CVs used by the onboarding spec: sample-cv.pdf and sample-cv.docx.
// Dependency free (hand-built PDF and a stored-only zip). Run: node make-fixtures.mjs
// The person and companies are fictional. The Kestrel role has no dates on
// purpose, so the Check screen has something to flag.
import { crc32 } from 'node:zlib'
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

// [text, style] where style is 'h1' | 'h2' | 'b' (bold) | 'p' | ''
const lines = [
  ['Mara Quill', 'h1'],
  ['Senior Backend Engineer', 'p'],
  ['mara.quill@example.com | +44 20 7946 0000 | linkedin.com/in/maraquill | London', 'p'],
  ['', ''],
  ['SUMMARY', 'h2'],
  ['Backend engineer with seven years building payment and ledger systems in Go and Rust.', 'p'],
  ['', ''],
  ['EXPERIENCE', 'h2'],
  ['Senior Backend Engineer, Larkspur Payments, London (2021 - Present)', 'b'],
  ['- Cut ledger reconciliation time by 60% by moving batch jobs to Kafka consumers in Go', 'p'],
  ['- Designed the Postgres partitioning scheme for 400M payment rows', 'p'],
  ['- Led a four person on-call rotation and wrote the incident runbooks', 'p'],
  ['Backend Engineer, Quarry Labs, Leeds (2018 - 2021)', 'b'],
  ['- Built the billing API in Rust used by 30 merchant integrations', 'p'],
  ['- Ran Terraform for three AWS accounts', 'p'],
  ['Software Engineer, Kestrel Systems, Leeds', 'b'],
  ['- Shipped internal REST APIs for the logistics team', 'p'],
  ['- Moved nightly reports from cron scripts to a queue based worker', 'p'],
  ['', ''],
  ['EDUCATION', 'h2'],
  ['University of Leeds, B.Sc. Computer Science, 2014 - 2018', 'p'],
  ['', ''],
  ['SKILLS', 'h2'],
  ['Languages: Go, Rust, SQL, Python', 'p'],
  ['Infrastructure: Postgres, Kafka, Kubernetes, Terraform, AWS', 'p'],
]

// ---- PDF -------------------------------------------------------------
function pdf() {
  const size = { h1: 20, h2: 12, b: 11, p: 10.5, '': 10.5 }
  const font = { h1: 'F2', h2: 'F2', b: 'F2', p: 'F1', '': 'F1' }
  let y = 790
  let stream = ''
  for (const [text, style] of lines) {
    const esc = text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')
    if (text) stream += `BT /${font[style]} ${size[style]} Tf 56 ${y} Td (${esc}) Tj ET\n`
    y -= style === 'h1' ? 28 : 17
  }
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,
  ]
  let out = '%PDF-1.4\n'
  const offsets = []
  objs.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out))
    out += `${i + 1} 0 obj\n${o}\nendobj\n`
  })
  const xref = Buffer.byteLength(out)
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`
  for (const o of offsets) out += `${String(o).padStart(10, '0')} 00000 n \n`
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}

// ---- DOCX (a zip with stored entries) --------------------------------
const xmlEsc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
function docxParts() {
  const body = lines
    .map(([t, style]) => {
      if (!t) return '<w:p/>'
      const bold = style === 'h1' || style === 'h2' || style === 'b' ? '<w:b/>' : ''
      const sz = style === 'h1' ? '<w:sz w:val="40"/>' : style === 'h2' ? '<w:sz w:val="24"/>' : ''
      return `<w:p><w:r><w:rPr>${bold}${sz}</w:rPr><w:t xml:space="preserve">${xmlEsc(t)}</w:t></w:r></w:p>`
    })
    .join('')
  return {
    '[Content_Types].xml':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    '_rels/.rels':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/document.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
  }
}

function zip(files) {
  const chunks = []
  const central = []
  let offset = 0
  for (const [name, content] of Object.entries(files)) {
    const nameBuf = Buffer.from(name)
    const data = Buffer.from(content)
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    chunks.push(local, nameBuf, data)
    const c = Buffer.alloc(46)
    c.writeUInt32LE(0x02014b50, 0)
    c.writeUInt16LE(20, 4)
    c.writeUInt16LE(20, 6)
    c.writeUInt32LE(crc, 16)
    c.writeUInt32LE(data.length, 20)
    c.writeUInt32LE(data.length, 24)
    c.writeUInt16LE(nameBuf.length, 28)
    c.writeUInt32LE(offset, 42)
    central.push(c, nameBuf)
    offset += local.length + nameBuf.length + data.length
  }
  const cd = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(Object.keys(files).length, 8)
  end.writeUInt16LE(Object.keys(files).length, 10)
  end.writeUInt32LE(cd.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...chunks, cd, end])
}

writeFileSync(join(here, 'sample-cv.pdf'), pdf())
writeFileSync(join(here, 'sample-cv.docx'), zip(docxParts()))
console.log('wrote sample-cv.pdf and sample-cv.docx')
