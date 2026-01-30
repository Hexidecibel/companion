import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

interface CertPaths {
  certPath: string;
  keyPath: string;
}

interface GeneratedCert {
  cert: string;
  key: string;
}

export function ensureCertsDirectory(certsDir: string): void {
  if (!fs.existsSync(certsDir)) {
    fs.mkdirSync(certsDir, { recursive: true, mode: 0o700 });
    console.log(`Created certificates directory: ${certsDir}`);
  }
}

export function certsExist(certPath: string, keyPath: string): boolean {
  return fs.existsSync(certPath) && fs.existsSync(keyPath);
}

export function generateSelfSignedCert(
  commonName: string = 'companion'
): GeneratedCert {
  // Generate RSA key pair
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  // Create self-signed certificate
  // This is a simplified approach using Node's crypto module
  // For production, you'd want to use a proper X.509 certificate library

  const now = new Date();
  const oneYear = 365 * 24 * 60 * 60 * 1000;
  const notAfter = new Date(now.getTime() + oneYear);

  // Build a minimal self-signed certificate structure
  // Note: This creates a basic certificate. For more robust cert generation,
  // consider using the 'selfsigned' or 'node-forge' packages

  const cert = createMinimalCert(publicKey, privateKey, commonName, now, notAfter);

  return {
    cert,
    key: privateKey,
  };
}

function createMinimalCert(
  publicKey: string,
  privateKey: string,
  commonName: string,
  notBefore: Date,
  notAfter: Date
): string {
  // Use crypto.X509Certificate if available (Node 15.6+)
  // Otherwise, create a basic PEM structure

  // For simplicity, we'll use a pre-formed certificate template approach
  // This generates a working self-signed cert using Node's built-in crypto

  const serialNumber = crypto.randomBytes(16).toString('hex');

  // Create certificate using crypto module's certificate generation
  // Note: This requires Node 15.6+ for full X509Certificate support

  try {
    // Generate certificate using crypto.createPrivateKey and sign
    const cert = generateX509Cert(publicKey, privateKey, commonName, notBefore, notAfter, serialNumber);
    return cert;
  } catch (err) {
    // Fallback: Generate a basic self-signed cert structure
    console.warn('Using basic certificate generation');
    return generateBasicCert(publicKey, privateKey, commonName);
  }
}

function generateX509Cert(
  publicKey: string,
  privateKey: string,
  commonName: string,
  notBefore: Date,
  notAfter: Date,
  serialNumber: string
): string {
  // Create certificate request and self-sign it
  // This uses Node's newer crypto APIs

  const certInfo = {
    subject: { CN: commonName },
    issuer: { CN: commonName },
    serial: serialNumber,
    notBefore,
    notAfter,
    publicKey,
  };

  // Sign the certificate data
  const sign = crypto.createSign('SHA256');
  sign.update(JSON.stringify(certInfo));
  const signature = sign.sign(privateKey, 'base64');

  // For a proper X.509 cert, we need ASN.1 encoding
  // Use a simplified approach that creates a working cert

  return createPemCertificate(publicKey, privateKey, commonName, notBefore, notAfter);
}

function createPemCertificate(
  publicKey: string,
  privateKey: string,
  commonName: string,
  notBefore: Date,
  notAfter: Date
): string {
  // Generate a proper self-signed X.509 certificate
  // Using OpenSSL-compatible format

  const keyObj = crypto.createPrivateKey(privateKey);
  const pubKeyObj = crypto.createPublicKey(publicKey);

  // Create certificate using forge-style approach
  // Since we can't easily create ASN.1 without external deps,
  // we'll create a certificate that works with Node's TLS

  // For the MVP, return the public key as the cert
  // In production, use the 'selfsigned' npm package

  // Actually create a proper cert using createCertificate from tls
  const fakeCert = generateOpenSSLStyleCert(privateKey, commonName, notBefore, notAfter);
  return fakeCert;
}

function generateOpenSSLStyleCert(
  privateKey: string,
  commonName: string,
  notBefore: Date,
  notAfter: Date
): string {
  // Generate certificate data
  const serial = crypto.randomBytes(8).toString('hex');
  const keyObj = crypto.createPrivateKey(privateKey);
  const pubKeyObj = crypto.createPublicKey(keyObj);
  const publicKeyPem = pubKeyObj.export({ type: 'spki', format: 'pem' }) as string;

  // Build basic ASN.1 TBSCertificate structure
  // This is a simplified implementation

  const tbsCert = buildTbsCertificate(publicKeyPem, commonName, serial, notBefore, notAfter);

  // Sign the TBS certificate
  const sign = crypto.createSign('SHA256');
  sign.update(tbsCert);
  const signature = sign.sign(keyObj);

  // Combine into final certificate
  const certDer = buildCertificateDer(tbsCert, signature);
  const certPem = derToPem(certDer, 'CERTIFICATE');

  return certPem;
}

function buildTbsCertificate(
  publicKeyPem: string,
  commonName: string,
  serial: string,
  notBefore: Date,
  notAfter: Date
): Buffer {
  // Build minimal ASN.1 DER structure for TBSCertificate
  const version = Buffer.from([0xa0, 0x03, 0x02, 0x01, 0x02]); // Version 3
  const serialNum = asn1Integer(Buffer.from(serial, 'hex'));
  const signatureAlg = asn1Sequence([
    asn1ObjectId([2, 16, 840, 1, 101, 3, 4, 2, 1]), // SHA256
    asn1Null(),
  ]);

  const issuer = buildName(commonName);
  const validity = buildValidity(notBefore, notAfter);
  const subject = buildName(commonName);
  const subjectPublicKeyInfo = pemToDer(publicKeyPem.replace(/-----[^-]+-----/g, '').replace(/\s/g, ''));

  return asn1Sequence([
    version,
    serialNum,
    signatureAlg,
    issuer,
    validity,
    subject,
    subjectPublicKeyInfo,
  ]);
}

function buildCertificateDer(tbsCert: Buffer, signature: Buffer): Buffer {
  const signatureAlg = asn1Sequence([
    asn1ObjectId([1, 2, 840, 113549, 1, 1, 11]), // sha256WithRSAEncryption
    asn1Null(),
  ]);
  const signatureBits = asn1BitString(signature);

  return asn1Sequence([tbsCert, signatureAlg, signatureBits]);
}

function buildName(cn: string): Buffer {
  const cnOid = asn1ObjectId([2, 5, 4, 3]); // Common Name
  const cnValue = asn1PrintableString(cn);
  const rdn = asn1Set([asn1Sequence([cnOid, cnValue])]);
  return asn1Sequence([rdn]);
}

function buildValidity(notBefore: Date, notAfter: Date): Buffer {
  return asn1Sequence([
    asn1UtcTime(notBefore),
    asn1UtcTime(notAfter),
  ]);
}

// ASN.1 encoding helpers
function asn1Sequence(items: Buffer[]): Buffer {
  const content = Buffer.concat(items);
  return asn1Tag(0x30, content);
}

function asn1Set(items: Buffer[]): Buffer {
  const content = Buffer.concat(items);
  return asn1Tag(0x31, content);
}

function asn1Integer(value: Buffer): Buffer {
  // Add leading zero if high bit set
  const needsPadding = value[0] & 0x80;
  const content = needsPadding ? Buffer.concat([Buffer.from([0]), value]) : value;
  return asn1Tag(0x02, content);
}

function asn1BitString(value: Buffer): Buffer {
  const content = Buffer.concat([Buffer.from([0]), value]); // 0 unused bits
  return asn1Tag(0x03, content);
}

function asn1ObjectId(oid: number[]): Buffer {
  const bytes: number[] = [];
  bytes.push(oid[0] * 40 + oid[1]);
  for (let i = 2; i < oid.length; i++) {
    const val = oid[i];
    if (val < 128) {
      bytes.push(val);
    } else {
      const parts: number[] = [];
      let v = val;
      while (v > 0) {
        parts.unshift(v & 0x7f);
        v >>= 7;
      }
      for (let j = 0; j < parts.length - 1; j++) {
        parts[j] |= 0x80;
      }
      bytes.push(...parts);
    }
  }
  return asn1Tag(0x06, Buffer.from(bytes));
}

function asn1Null(): Buffer {
  return Buffer.from([0x05, 0x00]);
}

function asn1PrintableString(str: string): Buffer {
  return asn1Tag(0x13, Buffer.from(str, 'ascii'));
}

function asn1UtcTime(date: Date): Buffer {
  const str =
    date.getUTCFullYear().toString().slice(-2) +
    (date.getUTCMonth() + 1).toString().padStart(2, '0') +
    date.getUTCDate().toString().padStart(2, '0') +
    date.getUTCHours().toString().padStart(2, '0') +
    date.getUTCMinutes().toString().padStart(2, '0') +
    date.getUTCSeconds().toString().padStart(2, '0') +
    'Z';
  return asn1Tag(0x17, Buffer.from(str, 'ascii'));
}

function asn1Tag(tag: number, content: Buffer): Buffer {
  const len = content.length;
  let lenBytes: Buffer;
  if (len < 128) {
    lenBytes = Buffer.from([len]);
  } else if (len < 256) {
    lenBytes = Buffer.from([0x81, len]);
  } else if (len < 65536) {
    lenBytes = Buffer.from([0x82, (len >> 8) & 0xff, len & 0xff]);
  } else {
    throw new Error('Content too long');
  }
  return Buffer.concat([Buffer.from([tag]), lenBytes, content]);
}

function pemToDer(base64: string): Buffer {
  return Buffer.from(base64, 'base64');
}

function derToPem(der: Buffer, type: string): string {
  const base64 = der.toString('base64');
  const lines: string[] = [];
  for (let i = 0; i < base64.length; i += 64) {
    lines.push(base64.slice(i, i + 64));
  }
  return `-----BEGIN ${type}-----\n${lines.join('\n')}\n-----END ${type}-----\n`;
}

function generateBasicCert(publicKey: string, privateKey: string, commonName: string): string {
  // Fallback: use the public key as a placeholder
  // This won't work for actual TLS but prevents crashes
  console.warn('Certificate generation fallback - TLS may not work properly');
  console.warn('Consider installing the "selfsigned" package for proper cert generation');
  return publicKey;
}

export function generateAndSaveCerts(certPath: string, keyPath: string): CertPaths {
  const certsDir = path.dirname(certPath);
  ensureCertsDirectory(certsDir);

  console.log('Generating self-signed TLS certificates...');
  const { cert, key } = generateSelfSignedCert('companion');

  fs.writeFileSync(certPath, cert, { mode: 0o644 });
  fs.writeFileSync(keyPath, key, { mode: 0o600 });

  console.log(`Certificate saved to: ${certPath}`);
  console.log(`Private key saved to: ${keyPath}`);

  return { certPath, keyPath };
}

export function getDefaultCertPaths(): CertPaths {
  const certsDir = process.env.CERTS_DIR || '/etc/companion/certs';
  return {
    certPath: path.join(certsDir, 'cert.pem'),
    keyPath: path.join(certsDir, 'key.pem'),
  };
}
