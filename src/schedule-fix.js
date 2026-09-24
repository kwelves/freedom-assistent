import worker from "./index.js";

export default {
  fetch(request, env, ctx) {
    return worker.fetch(request, env, ctx);
  },

  scheduled(controller, env, ctx) {
    if (controller.cron === "0 13 * * THU") return;
    return worker.scheduled(controller, env, ctx);
  }
};
