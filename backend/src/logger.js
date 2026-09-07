const LEVELS = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

export function createLogger({ level = 'info' } = {}) {
  const minimum = LEVELS[level] ?? LEVELS.info;

  function write(levelName, message, fields = {}) {
    if ((LEVELS[levelName] ?? LEVELS.info) < minimum) {
      return;
    }

    const record = {
      level: levelName,
      message,
      time: new Date().toISOString(),
      ...fields
    };

    const line = JSON.stringify(record);
    if (levelName === 'error') {
      console.error(line);
      return;
    }
    console.log(line);
  }

  return {
    debug: (message, fields) => write('debug', message, fields),
    error: (message, fields) => write('error', message, fields),
    info: (message, fields) => write('info', message, fields),
    warn: (message, fields) => write('warn', message, fields)
  };
}
