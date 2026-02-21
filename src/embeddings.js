import { pipeline } from '@xenova/transformers';

let extractor = null;

async function getExtractor() {
  if (!extractor) {
    extractor = await pipeline(
      'feature-extraction',
      'Xenova/all-MiniLM-L6-v2',
      { quantized: true }
    );
  }
  return extractor;
}

export async function embedText(text) {
  const model = await getExtractor();
  const output = await model(text, {
    pooling: 'mean',
    normalize: true,
  });
  const arr = output.tolist ? output.tolist() : Array.from(output.data);
  return Array.isArray(arr[0]) ? arr[0] : arr;
}
