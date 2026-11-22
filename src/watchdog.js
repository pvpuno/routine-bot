const ALERT_WINDOW_MS = 6 * 3600000;

export function createPollWatchdog(repo, poller, adminId, logger = console) {
  return async (err, consecutive) => {
    const admin = String(adminId || '').trim();
    if (!admin || consecutive < 3) return;
    const last = repo.cursor('poll_alert');
    if (last && Date.now() - Date.parse(last) < ALERT_WINDOW_MS) return;
    repo.saveCursor('poll_alert', new Date().toISOString());
    try {
      await poller.sendMessage(
        admin,
        `routine-bot: getUpdates viene fallando (${consecutive} intentos seguidos). Último error: ${err.message}. Revisá conectividad o el token del bot.`
      );
    } catch (e) {
      logger.error(`watchdog no pudo avisar al admin: ${e.message}`);
    }
  };
}
