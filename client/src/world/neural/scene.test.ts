// Tema "Cérebro": sessão fechada no terminal (some do snapshot) não pode ficar como fantasma na cena.
// A coreografia de saída do prédio (andar até o elevador) nunca termina aqui, porque o layout
// reescreve a posição a cada frame — então quem sai precisa sumir na hora.
import { describe, expect, it } from 'vitest';
import type { AgentInfo, OfficeSnapshot, RoomInfo } from '../../../../shared/types';
import type { Appearance, ArtModule, RoomTheme } from '../../art/api';
import { DEFAULT_WORLD_OPTIONS } from '../api';
import { Sim } from '../sim/sim';
import { NeuralScene } from './scene';

const T0 = 1_700_000_000_000;

const theme = {
  carpet: '#4f6d8f',
  carpet2: '#486685',
  wall: { base: '#e6e2da', trim: '#9a8f80', pattern: 'plain' },
  accent: '#3f7fd8',
  deskVariant: 'wood',
  chairVariant: 'black',
} as RoomTheme;
const appearance = { skin: '#f0c8a0', hairStyle: 'short', topStyle: 'tshirt', accessory: 'none', lanyard: null, look: 'm' } as unknown as Appearance;
const art = { appearanceFromSeed: () => appearance, roomTheme: () => theme } as unknown as ArtModule;

const room = (id: string, slot: number): RoomInfo => ({ id, name: id.replace('/', ''), path: id, slot, seed: slot * 99 + 7, createdAt: T0 });

function agent(id: string, roomId: string, extra: Partial<AgentInfo> = {}): AgentInfo {
  return {
    id,
    kind: 'main',
    roomId,
    name: 'Frinus',
    look: 'f',
    role: 'Agente principal',
    sessionId: `s-${id}`,
    account: '.claude',
    status: 'working',
    recent: [],
    tasks: [],
    startedAt: T0,
    lastEventAt: T0,
    statusSince: T0,
    stats: { toolCalls: 0, tokensIn: 0, tokensOut: 0, subagents: 0 },
    seed: id.length * 1234567,
    ...extra,
  };
}

function snap(rooms: RoomInfo[], agents: AgentInfo[], serverTime: number, rev: number): OfficeSnapshot {
  return {
    rev,
    serverTime,
    rooms,
    agents,
    accounts: [{ id: '.claude', short: 'C', name: 'Conta C', color: '#f08a3c', configDir: '~/.claude', sessions: 1, usageStatus: 'ok' }],
    meta: { demo: true, sources: [], startedAt: T0, version: 't' },
  };
}

/** Laço igual ao do world/index.ts no tema frinus: sim.update e depois o layout neural. */
function run(sim: Sim, scene: NeuralScene, clock: { now: number }, seconds: number): void {
  for (let i = 0; i < Math.round(seconds * 30); i++) {
    clock.now += 1000 / 30;
    sim.update(1 / 30, clock.now);
    scene.layout(sim, clock.now);
  }
}

describe('cena neural: sessões encerradas', () => {
  it('sessão (e seu especialista) que sai do snapshot some da cena sem recarregar', () => {
    const sim = new Sim(art, () => ({ ...DEFAULT_WORLD_OPTIONS, liveliness: 'calm' }));
    const scene = new NeuralScene();
    const clock = { now: T0 };
    const rooms = [room('/frinus', 0)];
    const live = agent('vivo', '/frinus');
    const closed = agent('fechado', '/frinus');
    const sub = agent('fechado:sub', '/frinus', { kind: 'sub', parentId: 'fechado', name: 'Especialista' });
    sim.applySnapshot(snap(rooms, [live, closed, sub], clock.now, 1), clock.now);
    run(sim, scene, clock, 2);
    expect([...sim.chars.keys()].sort()).toEqual(['fechado', 'fechado:sub', 'vivo']);

    // terminal fechado: a sessão e o subagente somem do snapshot
    sim.applySnapshot(snap(rooms, [live], clock.now, 2), clock.now);
    run(sim, scene, clock, 6);
    expect([...sim.chars.keys()]).toEqual(['vivo']);
  });
});
