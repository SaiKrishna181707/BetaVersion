import fs from 'node:fs';
import zlib from 'node:zlib';

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Creates a valid ZIP archive containing a single file.
 * Completely cross-platform in pure Node.js (no external OS tools or dependencies).
 */
export function zipSingleFile(sourceFilePath, entryName, destinationZipPath) {
  const fileData = fs.readFileSync(sourceFilePath);
  const deflated = zlib.deflateRawSync(fileData);
  const crc = crc32(fileData);
  const entryNameBuf = Buffer.from(entryName, 'utf8');

  // Local File Header (30 bytes + name)
  const localHeader = Buffer.alloc(30 + entryNameBuf.length);
  localHeader.writeUInt32LE(0x04034b50, 0); // Signature
  localHeader.writeUInt16LE(20, 4);          // Version needed (2.0)
  localHeader.writeUInt16LE(0, 6);           // General purpose bit flag
  localHeader.writeUInt16LE(8, 8);           // Compression method (8 = Deflate)
  localHeader.writeUInt16LE(0, 10);          // Last mod time
  localHeader.writeUInt16LE(0, 12);          // Last mod date
  localHeader.writeUInt32LE(crc, 14);        // CRC-32
  localHeader.writeUInt32LE(deflated.length, 18); // Compressed size
  localHeader.writeUInt32LE(fileData.length, 22); // Uncompressed size
  localHeader.writeUInt16LE(entryNameBuf.length, 26); // Filename length
  localHeader.writeUInt16LE(0, 28);          // Extra field length
  entryNameBuf.copy(localHeader, 30);

  const localOffset = 0;

  // Central Directory Record (46 bytes + name)
  const cdHeader = Buffer.alloc(46 + entryNameBuf.length);
  cdHeader.writeUInt32LE(0x02014b50, 0);     // Signature
  cdHeader.writeUInt16LE(20, 4);             // Version made by
  cdHeader.writeUInt16LE(20, 6);             // Version needed
  cdHeader.writeUInt16LE(0, 8);              // General purpose bit flag
  cdHeader.writeUInt16LE(8, 10);             // Compression method (Deflate)
  cdHeader.writeUInt16LE(0, 12);             // Last mod time
  cdHeader.writeUInt16LE(0, 14);             // Last mod date
  cdHeader.writeUInt32LE(crc, 16);           // CRC-32
  cdHeader.writeUInt32LE(deflated.length, 20); // Compressed size
  cdHeader.writeUInt32LE(fileData.length, 24); // Uncompressed size
  cdHeader.writeUInt16LE(entryNameBuf.length, 28); // Filename length
  cdHeader.writeUInt16LE(0, 30);             // Extra field length
  cdHeader.writeUInt16LE(0, 32);             // File comment length
  cdHeader.writeUInt16LE(0, 34);             // Disk number start
  cdHeader.writeUInt16LE(0, 36);             // Internal file attributes
  cdHeader.writeUInt32LE(0x81a40000, 38);   // External file attributes (-rw-r--r--)
  cdHeader.writeUInt32LE(localOffset, 42);   // Relative offset of local header
  entryNameBuf.copy(cdHeader, 46);

  const cdOffset = localHeader.length + deflated.length;
  const cdSize = cdHeader.length;

  // End of Central Directory Record (22 bytes)
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);         // Signature
  eocd.writeUInt16LE(0, 4);                  // Disk number
  eocd.writeUInt16LE(0, 6);                  // Disk with start of CD
  eocd.writeUInt16LE(1, 8);                  // Total entries on this disk
  eocd.writeUInt16LE(1, 10);                 // Total entries
  eocd.writeUInt32LE(cdSize, 12);            // Size of CD
  eocd.writeUInt32LE(cdOffset, 16);          // Offset of CD
  eocd.writeUInt16LE(0, 20);                 // Comment length

  const zipBuffer = Buffer.concat([localHeader, deflated, cdHeader, eocd]);
  fs.writeFileSync(destinationZipPath, zipBuffer);
  return zipBuffer;
}
