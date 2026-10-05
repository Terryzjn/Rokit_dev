// Rokit · OAuth 2.0 PKCE 工具（RFC 7636）
// 生成高熵随机 code_verifier + 对应 S256 code_challenge
'use strict';

const crypto = require('crypto');

// RFC 7636 §4.1：43~128 字符 [A-Z a-z 0-9 - . _ ~]
function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function randomString(len) {
  return base64url(crypto.randomBytes(Math.ceil((len * 3) / 4))).slice(0, len);
}

function generateVerifier() {
  return randomString(64);
}

function challengeFromVerifier(verifier) {
  return base64url(crypto.createHash('sha256').update(verifier, 'ascii').digest());
}

function generateState() {
  return randomString(32);
}

module.exports = {
  generateVerifier,
  challengeFromVerifier,
  generateState
};
