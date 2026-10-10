const { test } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const up = require('../api/uploader');

test('SigV4 matches the AWS documented example (GET object with a Range header)', () => {
  const auth = up.signV4({
    method: 'GET', pathname: '/test.txt', query: '',
    headers: { host: 'examplebucket.s3.amazonaws.com', range: 'bytes=0-9', 'x-amz-content-sha256': 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', 'x-amz-date': '20130524T000000Z' },
    payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', region: 'us-east-1', amzDate: '20130524T000000Z'
  });
  assert.match(auth, /Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41$/);
  assert.match(auth, /^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\/20130524\/us-east-1\/s3\/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date,/);
});

test('keys are encoded and the target follows path-style for custom endpoints', () => {
  assert.strictEqual(up.encodeKey('backups/my db (1)/a b.sql.gz'), 'backups/my%20db%20%281%29/a%20b.sql.gz');
  const t = up.s3Target({ bucket: 'bk', endpoint: 'http://127.0.0.1:9000', accessKeyId: 'a', secretAccessKey: 'b' }, 'x/y.gz');
  assert.strictEqual(t.pathname, '/bk/x/y.gz');
  const aws = up.s3Target({ bucket: 'bk', region: 'eu-west-1', accessKeyId: 'a', secretAccessKey: 'b' }, 'y.gz');
  assert.strictEqual(aws.host, 'bk.s3.eu-west-1.amazonaws.com');
});

test('uploadS3 sends the file with a signed PUT', async () => {
  const seen = {};
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      Object.assign(seen, { method: req.method, url: req.url, auth: req.headers.authorization, hash: req.headers['x-amz-content-sha256'], body: Buffer.concat(chunks).toString() });
      if (!/Credential=AKIATEST\//.test(req.headers.authorization || '')) { res.statusCode = 403; return res.end('<Error><Message>bad key</Message></Error>'); }
      res.statusCode = 200; res.end();
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const file = path.join(os.tmpdir(), 'dbc-up-' + Date.now() + '.txt');
  fs.writeFileSync(file, 'hello backup');
  try {
    const cfg = { type: 's3', endpoint: `http://127.0.0.1:${server.address().port}`, bucket: 'bk', region: 'us-east-1', accessKeyId: 'AKIATEST', secretAccessKey: 'secret', prefix: 'dbc/' };
    const r = await up.upload(cfg, file, { name: 'one.txt' });
    assert.strictEqual(r.target, 's3://bk/dbc/one.txt');
    assert.deepStrictEqual([seen.method, seen.url, seen.body, seen.hash], ['PUT', '/bk/dbc/one.txt', 'hello backup', 'UNSIGNED-PAYLOAD']);
    await assert.rejects(up.upload({ ...cfg, accessKeyId: 'WRONG' }, file, { name: 'two.txt' }), /403: bad key/);
  } finally { server.close(); fs.rmSync(file, { force: true }); }
});
