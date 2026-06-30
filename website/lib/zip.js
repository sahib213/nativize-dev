/*
 * Nativize tiny ZIP writer — PURE, dependency-free.
 *
 * Produces a valid "stored" (uncompressed, method 0) ZIP from a
 * { path: string } file map. Store-only keeps it ~100 lines and avoids any
 * compression dependency; kit files are small so size is a non-issue.
 *
 * Browser usage:  const blob = NativizeZip.toBlob(files);
 * Node usage:     const buf  = NativizeZip.toUint8Array(files);  // for tests
 *
 * Output is a real ZIP that macOS Archive Utility, Windows Explorer, and
 * `unzip` all open.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.NativizeZip = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // CRC-32 table (IEEE 802.3 polynomial), built once.
  var CRC_TABLE = (function () {
    var table = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    var crc = 0xffffffff;
    for (var i = 0; i < bytes.length; i++) {
      crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  // UTF-8 encode without depending on TextEncoder being present everywhere.
  function utf8(str) {
    if (typeof TextEncoder !== "undefined") {
      return new TextEncoder().encode(str);
    }
    // Node fallback.
    return new Uint8Array(Buffer.from(str, "utf8"));
  }

  function writeU16(arr, v) {
    arr.push(v & 0xff, (v >>> 8) & 0xff);
  }
  function writeU32(arr, v) {
    arr.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
  }
  function pushBytes(arr, bytes) {
    for (var i = 0; i < bytes.length; i++) arr.push(bytes[i]);
  }

  function toUint8Array(files) {
    var localParts = []; // bytes of all local file records
    var central = []; // bytes of central directory
    var offset = 0;
    var count = 0;

    Object.keys(files).forEach(function (path) {
      var nameBytes = utf8(path);
      // Accept binary entries (Uint8Array / ArrayBuffer) as-is so we can zip
      // images and other non-text files; coerce everything else to UTF-8 text.
      var value = files[path];
      var dataBytes = (value instanceof Uint8Array) ? value
        : (value instanceof ArrayBuffer) ? new Uint8Array(value)
        : utf8(String(value));
      var crc = crc32(dataBytes);
      var size = dataBytes.length;

      // ---- Local file header ----
      var local = [];
      writeU32(local, 0x04034b50); // local file header signature
      writeU16(local, 20); // version needed
      writeU16(local, 0x0800); // general purpose flag: UTF-8 filename
      writeU16(local, 0); // method: 0 = stored
      writeU16(local, 0); // mod time
      writeU16(local, 0); // mod date
      writeU32(local, crc);
      writeU32(local, size); // compressed size (== size, stored)
      writeU32(local, size); // uncompressed size
      writeU16(local, nameBytes.length);
      writeU16(local, 0); // extra length
      pushBytes(local, nameBytes);
      pushBytes(local, dataBytes);

      // ---- Central directory header ----
      writeU32(central, 0x02014b50);
      writeU16(central, 20); // version made by
      writeU16(central, 20); // version needed
      writeU16(central, 0x0800); // UTF-8 flag
      writeU16(central, 0); // method
      writeU16(central, 0); // time
      writeU16(central, 0); // date
      writeU32(central, crc);
      writeU32(central, size);
      writeU32(central, size);
      writeU16(central, nameBytes.length);
      writeU16(central, 0); // extra
      writeU16(central, 0); // comment
      writeU16(central, 0); // disk number
      writeU16(central, 0); // internal attrs
      writeU32(central, 0); // external attrs
      writeU32(central, offset); // local header offset
      pushBytes(central, nameBytes);

      localParts.push(local);
      offset += local.length;
      count++;
    });

    var centralOffset = offset;
    var centralSize = central.length;

    // ---- End of central directory ----
    var end = [];
    writeU32(end, 0x06054b50);
    writeU16(end, 0); // disk number
    writeU16(end, 0); // central dir start disk
    writeU16(end, count); // records on this disk
    writeU16(end, count); // total records
    writeU32(end, centralSize);
    writeU32(end, centralOffset);
    writeU16(end, 0); // comment length

    // Concatenate everything.
    var total = centralOffset + centralSize + end.length;
    var out = new Uint8Array(total);
    var p = 0;
    for (var i = 0; i < localParts.length; i++) {
      out.set(localParts[i], p);
      p += localParts[i].length;
    }
    out.set(central, p);
    p += central.length;
    out.set(end, p);
    return out;
  }

  function toBlob(files) {
    return new Blob([toUint8Array(files)], { type: "application/zip" });
  }

  return { toUint8Array: toUint8Array, toBlob: toBlob, crc32: crc32 };
});
