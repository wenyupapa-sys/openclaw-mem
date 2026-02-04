#!/usr/bin/env node
/**
 * Backfill embeddings for existing observations.
 * Run manually: node backfill-embeddings.js
 *
 * Finds all observations without embeddings and generates them
 * in batches of 16 using the DeepSeek embeddings API.
 */

import database from './database.js';
import { batchEmbeddings } from './gateway-llm.js';

const BATCH_SIZE = 16;

async function backfill() {
  const totalObs = database.getStats().total_observations;
  const existingEmbeddings = database.getEmbeddingCount();
  console.log(`Total observations: ${totalObs}`);
  console.log(`Existing embeddings: ${existingEmbeddings}`);
  console.log(`Missing: ~${totalObs - existingEmbeddings}`);
  console.log('');

  let processed = 0;
  let saved = 0;
  let failed = 0;

  while (true) {
    const batch = database.getObservationsWithoutEmbeddings(BATCH_SIZE);
    if (batch.length === 0) break;

    // Build text for each observation
    const texts = batch.map(obs => {
      const parts = [obs.summary, obs.narrative].filter(Boolean);
      return parts.join(' ').trim() || `Observation #${obs.id}`;
    });

    console.log(`Batch ${Math.floor(processed / BATCH_SIZE) + 1}: generating embeddings for ${batch.length} observations (IDs ${batch[0].id}-${batch[batch.length - 1].id})...`);

    const embeddings = await batchEmbeddings(texts);

    for (let i = 0; i < batch.length; i++) {
      const obs = batch[i];
      const embedding = embeddings[i];

      if (embedding) {
        const result = database.saveEmbedding(obs.id, embedding);
        if (result.success) {
          saved++;
        } else {
          failed++;
          console.error(`  Failed to save embedding for #${obs.id}: ${result.error}`);
        }
      } else {
        failed++;
        console.error(`  No embedding returned for #${obs.id}`);
      }
    }

    processed += batch.length;
    console.log(`  Progress: ${saved} saved, ${failed} failed, ${processed} processed`);

    // Small delay between batches to avoid rate limiting
    if (batch.length === BATCH_SIZE) {
      await new Promise(r => setTimeout(r, 500));
    }
  }

  console.log('');
  console.log('=== Backfill Complete ===');
  console.log(`Processed: ${processed}`);
  console.log(`Saved: ${saved}`);
  console.log(`Failed: ${failed}`);
  console.log(`Total embeddings now: ${database.getEmbeddingCount()}`);
}

backfill().catch(err => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
