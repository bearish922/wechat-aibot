import { addRoute } from "./server.mjs";
import { token, activeAI } from "./state.mjs";

export function registerControlRoutes() {
  addRoute("GET", "/api/control", () => ({
    ok: true,
    running: true,
    tokenValid: Boolean(token),
    currentAI: activeAI,
  }));
}
