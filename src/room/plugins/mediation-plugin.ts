import type { PluginManifest } from '../contracts';

interface PluginContext {
  participants: Array<{ agentId: string; displayName: string }>;
  objective: string;
  cycle: number;
  turnIndex: number;
}

interface RoomMessageTurn {
  agentId: string;
  text: string;
}

interface MediationPluginState {
  nextSpeakerIndex: number;
  introduced: boolean;
}

interface PluginDecision {
  type: 'speak' | 'fan_out' | 'pause' | 'stop';
  targetAgentId?: string;
  prompt?: string;
  reason?: string;
}

export interface MediationPlugin {
  manifest: PluginManifest;
  init(ctx: PluginContext): MediationPluginState;
  onRoomStart(ctx: PluginContext, state: MediationPluginState): { state: MediationPluginState; decision: PluginDecision };
  onTurnResult(
    ctx: PluginContext,
    state: MediationPluginState,
    turn: RoomMessageTurn,
  ): { state: MediationPluginState; decision: PluginDecision };
}

const manifest: PluginManifest = {
  id: 'mediation-core',
  name: 'Mediation Core',
  version: '1.0.0',
  orchestratorType: 'mediation',
  roles: {
    required: ['party'],
    optional: ['mediator'],
    forbidden: [],
    minCount: {
      party: 2,
    },
  },
  description: 'Round-robin facilitation plugin for mediated group chat flow.',
  supportsQuorum: true,
};

function buildFacilitationPrompt(ctx: PluginContext, speaker: { displayName: string }): string {
  if (ctx.turnIndex === 0) {
    return `Please introduce your priorities for \"${ctx.objective}\" in 2-3 concise points.`;
  }
  return `Respond constructively to the prior turn and offer one concrete next-step proposal for \"${ctx.objective}\".`;
}

function nextIndex(state: MediationPluginState, participantCount: number): number {
  if (participantCount <= 0) {
    return 0;
  }
  return (state.nextSpeakerIndex + 1) % participantCount;
}

export default function createMediationPlugin(): MediationPlugin {
  return {
    manifest,

    init(): MediationPluginState {
      return {
        nextSpeakerIndex: 0,
        introduced: false,
      };
    },

    onRoomStart(ctx: PluginContext, state: MediationPluginState) {
      if (ctx.participants.length === 0) {
        return {
          state,
          decision: {
            type: 'stop',
            reason: 'no participants configured',
          },
        };
      }

      const speaker = ctx.participants[state.nextSpeakerIndex] || ctx.participants[0];
      return {
        state: {
          ...state,
          introduced: true,
        },
        decision: {
          type: 'speak',
          targetAgentId: speaker.agentId,
          prompt: buildFacilitationPrompt(ctx, speaker),
        },
      };
    },

    onTurnResult(ctx: PluginContext, state: MediationPluginState) {
      if (ctx.participants.length === 0) {
        return {
          state,
          decision: {
            type: 'stop',
            reason: 'participant set became empty',
          },
        };
      }

      const index = nextIndex(state, ctx.participants.length);
      const speaker = ctx.participants[index];

      return {
        state: {
          ...state,
          nextSpeakerIndex: index,
        },
        decision: {
          type: 'speak',
          targetAgentId: speaker.agentId,
          prompt: buildFacilitationPrompt(ctx, speaker),
        },
      };
    },
  };
}
