const chalk = require('chalk');

const createLogger = () => {
  const formatMessage = (message) => {
    const timestamp = new Date().toISOString();
    if (typeof message === 'object' && message !== null) {
      return `${timestamp} ${JSON.stringify(message, null, 2)}`;
    }
    return `${timestamp} ${message}`;
  };

  return {
    info: (message) => console.log(chalk.blue(`[INFO] ${formatMessage(message)}`)),
    success: (message) => console.log(chalk.green(`[SUCCESS] ${formatMessage(message)}`)),
    error: (message) => console.error(chalk.red(`[ERROR] ${formatMessage(message)}`)),
    warn: (message) => console.warn(chalk.yellow(`[WARN] ${formatMessage(message)}`)),
  };
};

module.exports = createLogger;