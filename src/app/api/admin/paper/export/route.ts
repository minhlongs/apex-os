/**
 * src/app/api/admin/paper/export/route.ts
 *
 * Admin API: Paper Trading Report Export (CSV & PDF)
 * Endpoint: GET /api/admin/paper/export?format=csv|pdf
 *
 * Every export is visibly stamped with execution_mode=PAPER, model_version,
 * max_feed_age_ms, and deterministic replay SHA-256 digest.
 */

import { NextRequest, NextResponse } from 'next/server';
import { buildCanonical50TickSequence } from '@/lib/paper/fixtures';
import { PaperJournal } from '@/lib/paper/journal';
import { PaperReplayEngine } from '@/lib/paper/replay';

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const format = (searchParams.get('format') || 'csv').toLowerCase();

  const ticks = buildCanonical50TickSequence();
  const replay = PaperReplayEngine.runReplay(ticks, { modelVersion: 'paper-v1.0.0' });
  const maxFeedAgeMs = replay.sequencerStates.reduce(
    (acc, s) => Math.max(acc, s.feedAgeMs),
    0
  );

  if (format === 'pdf') {
    const economicResearch = PaperReplayEngine.buildEconomicResearchSummary(replay, {
      generatedAt: new Date(1761840050000).toISOString(),
    });
    const pdfPayload = PaperJournal.formatPdfReport({
      cycles: replay.closedCycles,
      strategies: replay.strategies,
      sequencerStates: replay.sequencerStates,
      economicResearch,
      modelVersion: replay.modelVersion,
      maxFeedAgeMs,
      replayDigest: replay.digest,
    });

    return new NextResponse(pdfPayload, {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': 'attachment; filename="apexos-paper-trading-report.pdf"',
        'X-Execution-Mode': 'PAPER',
        'X-Model-Version': replay.modelVersion,
        'X-Replay-Digest': replay.digest,
      },
    });
  }

  const csvPayload = PaperJournal.formatCsvReport({
    cycles: replay.closedCycles,
    modelVersion: replay.modelVersion,
    maxFeedAgeMs,
    replayDigest: replay.digest,
  });

  return new NextResponse(csvPayload, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="apexos-paper-trading-journal.csv"',
      'X-Execution-Mode': 'PAPER',
      'X-Model-Version': replay.modelVersion,
      'X-Replay-Digest': replay.digest,
    },
  });
}
