from pathlib import Path
import json
r=Path(__file__).resolve().parents[1]
p=r/'src/util.ts';s=p.read_text();old='''  const bytes = new Uint8Array(buffer);
  let binary = "";''';new='''  const bytes = new Uint8Array(buffer);
  // Native typed-array codecs avoid millions of JS argument conversions on Workers Free.
  const native = bytes as Uint8Array & { toBase64?: () => string };
  if (native.toBase64) return native.toBase64();
  let binary = "";''';assert old in s;s=s.replace(old,new);p.write_text(s)
p=r/'src/media-store.ts';s=p.read_text();old='''      await ensureMediaSchema(env);
      const digest = await mediaDigest(buffer);
      const chunks: string[] = [];''';new='''      await ensureMediaSchema(env);
      // Avoid encoding or transferring a large object again on queue redelivery/cancellation.
      // The atomic INSERT below still rechecks both conditions against concurrent changes.
      const prior = await db.prepare(`SELECT
        (SELECT digest FROM media_objects WHERE key=?) AS digest,
        (SELECT size FROM media_objects WHERE key=?) AS size,
        EXISTS(SELECT 1 FROM media_tombstones WHERE key=?) AS cancelled`)
        .bind(key, key, key).first<{digest:string|null;size:number|null;cancelled:number}>();
      if (prior?.cancelled) throw new MediaLimitError("cancelled");
      const digest = await mediaDigest(buffer);
      if (prior?.digest) {
        if (prior.digest !== digest || prior.size !== buffer.byteLength) throw new Error("Attachment key collision; original data preserved");
        return;
      }
      const chunks: string[] = [];''';assert old in s;s=s.replace(old,new)
old='''            const binary = atob(chunk.data);
            const expected = Math.min(MEDIA_CHUNK_BYTES, row.size - offset);
            if (binary.length !== expected) throw new Error("Attachment chunk size invalid");
            for (let j = 0; j < binary.length; j++) output[offset + j] = binary.charCodeAt(j);
            offset += binary.length;''';new='''            const codec = Uint8Array as unknown as {fromBase64?: (value:string) => Uint8Array};
            const decoded = codec.fromBase64 ? codec.fromBase64(chunk.data) : Uint8Array.from(atob(chunk.data), c => c.charCodeAt(0));
            const expected = Math.min(MEDIA_CHUNK_BYTES, row.size - offset);
            if (decoded.byteLength !== expected) throw new Error("Attachment chunk size invalid");
            output.set(decoded, offset);
            offset += decoded.byteLength;''';assert old in s;s=s.replace(old,new);p.write_text(s)
p=r/'src/storage-verification.ts';s=p.read_text().replace('STORAGE_RELEASE = "1.7.0"','STORAGE_RELEASE = "1.7.1"');s=s.replace('  let before: Record<string,number> | null = null;','''  const phase = (name: string) => { result.phase=name; console.log(`storage_verification_phase ${name}`); };
  let before: Record<string,number> | null = null;''');s=s.replace('    before = await counts();','    before = await counts();\n    phase("max_size_save");');s=s.replace('    const obj = await store.get(objectKey);','    phase("max_size_read");\n    const obj = await store.get(objectKey);');s=s.replace('    await store.put(objectKey,sample.buffer,{contentType:"application/octet-stream"});\n    result.chunkRoundTrip=true;','    phase("duplicate_save");\n    await store.put(objectKey,sample.buffer,{contentType:"application/octet-stream"});\n    result.chunkRoundTrip=true;');s=s.replace('    await store.delete(objectKey);','    phase("delete_and_retry");\n    await store.delete(objectKey);');s=s.replace('    const challenge = ', '    phase("text_attachment_model");\n    const challenge = ');s=s.replace('    // A fixed synthetic blue PNG','    phase("image_attachment_model");\n    // A fixed synthetic blue PNG');s=s.replace('    const connection = ', '    phase("line_connection");\n    const connection = ');s=s.replace('  } finally {\n    try { await store.deleteGroup(group);','  } finally {\n    phase("cleanup");\n    try { await store.deleteGroup(group);');p.write_text(s)
p=r/'package.json';c=json.loads(p.read_text());c['version']='1.7.1';p.write_text(json.dumps(c,indent=2)+'\n');p=r/'package-lock.json';c=json.loads(p.read_text());c['version']='1.7.1';c['packages']['']['version']='1.7.1';p.write_text(json.dumps(c,indent=2)+'\n')
p=r/'docs/D1_MEDIA.md';s=p.read_text().replace('v1.7.0','v1.7.1').replace('"release":"1.7.0"','"release":"1.7.1"');s+='\nネイティブUint8Arrayのbase64変換を使い、重複保存・取消済みキーは大きなバイナリを再送する前に判定します。CPU上限を超える場合に有料化で回避することはありません。本番のHTTPヘルスチェックと署名拒否テストもmainのCIで実行します。\n';p.write_text(s)
p=r/'.github/workflows/ci.yml';s=p.read_text();assert 'production-http:' not in s;s+='''  production-http:
    needs: check
    if: github.event_name == 'push' && github.ref == 'refs/heads/main' && github.repository == 'kitworks-iino/line-home-ai'
    runs-on: ubuntu-latest
    timeout-minutes: 4
    steps:
      - uses: actions/checkout@v6
      - uses: actions/setup-node@v6
        with:
          node-version: 22
          package-manager-cache: false
      - name: Verify deployed HTTP health and signature rejection
        run: node scripts/production-smoke.mjs
      - uses: actions/upload-artifact@v4
        with:
          name: production-http-${{ github.sha }}
          path: production-http-artifact/
          retention-days: 1
''';p.write_text(s)
