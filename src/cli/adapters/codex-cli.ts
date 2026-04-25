import type { PlatformAdapter } from '../types.js';

const ansiRegex = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;

function addMetadata(metadata: Record<string, unknown>, key: string, value: unknown): void {
  if (value !== undefined) {
    metadata[key] = value;
  }
}

/**
 * Codex CLI hook adapter.
 *
 * Codex hook stdin currently uses Claude-like snake_case fields with Codex-specific
 * metadata (turn_id, model, permission_mode, tool_use_id). Keep this adapter
 * explicit so Codex hook-first ingestion does not depend on the generic raw
 * fallback and does not alter Claude/Gemini/Cursor normalization.
 */
export const codexCliAdapter: PlatformAdapter = {
  normalizeInput(raw) {
    const r = (raw ?? {}) as any;
    const metadata: Record<string, unknown> = {};

    addMetadata(metadata, 'hook_event_name', r.hook_event_name);
    addMetadata(metadata, 'turn_id', r.turn_id);
    addMetadata(metadata, 'model', r.model);
    addMetadata(metadata, 'permission_mode', r.permission_mode);
    addMetadata(metadata, 'source', r.source);
    addMetadata(metadata, 'reason', r.reason);
    addMetadata(metadata, 'tool_use_id', r.tool_use_id);

    return {
      sessionId: r.session_id ?? r.sessionId ?? r.id,
      cwd: r.cwd ?? process.cwd(),
      prompt: r.prompt,
      toolName: r.tool_name ?? r.toolName,
      toolUseId: r.tool_use_id ?? r.toolUseId,
      toolInput: r.tool_input ?? r.toolInput,
      toolResponse: r.tool_response ?? r.toolResponse,
      transcriptPath: r.transcript_path ?? r.transcriptPath,
      metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    };
  },

  formatOutput(result) {
    const output: Record<string, unknown> = {
      continue: result.continue ?? true,
    };

    if (result.systemMessage) {
      output.systemMessage = result.systemMessage.replace(ansiRegex, '');
    }

    const additionalContext = result.hookSpecificOutput?.additionalContext;
    if (additionalContext) {
      output.additionalContext = additionalContext;
    }

    return output;
  },
};
