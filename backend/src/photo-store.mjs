import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

// Item photos are stored under a name made from their own content, so a photo never changes once
// written and can be cached forever. The key format is the only path the readers below accept.
export const PHOTO_KEY = /^items\/[a-z0-9][a-z0-9-]{1,38}[a-z0-9]\/[a-f0-9]{64}\.(jpg|png|webp)$/;
export const photoTypes = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
const cacheControl = 'public, max-age=31536000, immutable';

// AWS: a private bucket served through CloudFront at baseUrl.
export function s3Photos({ bucket, baseUrl, client = new S3Client({}) }) {
  return {
    baseUrl,
    put: (key, body, contentType) => client.send(new PutObjectCommand({
      Bucket: bucket, Key: key, Body: body, ContentType: contentType, CacheControl: cacheControl,
    })),
  };
}

// Docker: files in a volume, served by the app at baseUrl.
export function diskPhotos({ dir, baseUrl }) {
  const root = resolve(dir);
  return {
    baseUrl, cacheControl,
    async put(key, body) {
      if (!PHOTO_KEY.test(key)) throw new Error('Invalid photo key');
      const file = join(root, key);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, body);
    },
    async read(key) {
      if (!PHOTO_KEY.test(key)) return null;
      return readFile(join(root, key)).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
    },
  };
}

// Tests and the lightweight preview: kept in memory.
export function memoryPhotos(baseUrl) {
  const files = new Map();
  return { baseUrl, cacheControl, files, put: async (key, body) => { files.set(key, body); }, read: async (key) => files.get(key) ?? null };
}
