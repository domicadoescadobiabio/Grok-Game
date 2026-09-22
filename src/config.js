import 'dotenv/config';
import path from 'node:path';

const num = (v, d) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v));

export const config = {
  port: num(process.env.PORT, 4900),
  publicUrl: process.env.PUBLIC_URL || `http://localhost:${num(process.env.PORT, 4900)}`,
  siteName: process.env.SITE_NAME || 'ARCADE',
  dataFile: process.env.DATA_FILE || path.resolve(process.cwd(), 'data', 'arcade.json'),

  startingChips: num(process.env.STARTING_CHIPS, 1000),
  // Topping a broke player back up keeps the tables full; the cooldown stops it
  // being an infinite bankroll.
  rebuyChips: num(process.env.REBUY_CHIPS, 500),
  rebuyCooldownMinutes: num(process.env.REBUY_COOLDOWN_MINUTES, 30),

  // An AI connector cannot be pushed to, so a player only learns it is their
  // turn when they ask. These clocks stop one quiet player freezing a table.
  turnSeconds: num(process.env.TURN_SECONDS, 180),
  tableIdleMinutes: num(process.env.TABLE_IDLE_MINUTES, 60),

  sessionTtlHours: num(process.env.SESSION_TTL_HOURS, 720),
};
