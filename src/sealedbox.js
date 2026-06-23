/*
 * Nativize sealed-box — libsodium crypto_box_seal, the exact scheme GitHub
 * requires for encrypting Actions/Dependabot secrets.
 *
 * crypto_box_seal(m, recipientPK):
 *   ephemeral = box.keyPair()
 *   nonce     = BLAKE2b-24( ephemeral.pk || recipientPK )      (no key)
 *   c         = box(m, nonce, recipientPK, ephemeral.sk)        (X25519-XSalsa20-Poly1305)
 *   sealed    = ephemeral.pk || c                                (32 + 16 + |m| bytes)
 *
 * Depends on the vendored tweetnacl (X25519 + XSalsa20-Poly1305) and the
 * vendored BLAKE2b — loaded as globals in the content script, or via require in
 * Node tests.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("./vendor/tweetnacl.js"), require("./vendor/blake2b.js"));
  } else {
    root.NativizeSealedBox = factory(root.nacl, root.NativizeBlake2b);
  }
})(typeof self !== "undefined" ? self : this, function (nacl, blake2b) {
  "use strict";

  if (!nacl || !nacl.box) throw new Error("tweetnacl not loaded");
  var b2b = blake2b.blake2b || blake2b;

  function concat(a, b) {
    var out = new Uint8Array(a.length + b.length);
    out.set(a, 0);
    out.set(b, a.length);
    return out;
  }

  function b64decode(s) {
    if (typeof atob === "function") {
      var bin = atob(s);
      var out = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    }
    return new Uint8Array(Buffer.from(s, "base64"));
  }

  function b64encode(bytes) {
    if (typeof btoa === "function") {
      var bin = "";
      for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
      return btoa(bin);
    }
    return Buffer.from(bytes).toString("base64");
  }

  function utf8(str) {
    if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(str);
    return new Uint8Array(Buffer.from(str, "utf8"));
  }

  /**
   * Seal raw bytes for a recipient X25519 public key (32 bytes).
   * @returns {Uint8Array} ephemeral_pk(32) || ciphertext
   */
  function seal(messageBytes, recipientPk) {
    if (recipientPk.length !== 32) throw new Error("recipient public key must be 32 bytes");
    var eph = nacl.box.keyPair();
    var nonce = b2b(concat(eph.publicKey, recipientPk), null, 24); // 24-byte BLAKE2b, unkeyed
    var boxed = nacl.box(messageBytes, nonce, recipientPk, eph.secretKey);
    return concat(eph.publicKey, boxed);
  }

  /**
   * Open a sealed box (used only in tests to prove round-trip correctness).
   */
  function sealOpen(sealed, recipientPk, recipientSk) {
    var ephPk = sealed.slice(0, 32);
    var boxed = sealed.slice(32);
    var nonce = b2b(concat(ephPk, recipientPk), null, 24);
    return nacl.box.open(boxed, nonce, ephPk, recipientSk);
  }

  /**
   * GitHub convenience: encrypt a secret string against a base64 repo public key,
   * returning base64 ciphertext ready for the Actions secrets API.
   */
  function sealBase64(plaintext, recipientPublicKeyBase64) {
    var pk = b64decode(recipientPublicKeyBase64);
    return b64encode(seal(utf8(plaintext), pk));
  }

  return {
    seal: seal,
    sealOpen: sealOpen,
    sealBase64: sealBase64,
    _b64encode: b64encode,
    _b64decode: b64decode
  };
});
