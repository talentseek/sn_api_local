const createLogger = require('../utils/logger');
const config = require('../utils/config');

module.exports = async function zoomHandler(page) {
  const logger = createLogger();

  try {
    logger.info('Applying zoom and resize settings...');

    // Set viewport from config
    const { width, height, deviceScaleFactor } = config.viewport;
    await page.setViewport({ width, height, deviceScaleFactor });
    logger.info(`Viewport set to: ${JSON.stringify(config.viewport)}`);

    // Apply CSS scaling from config
    const { scale, widthMultiplier, heightMultiplier } = config.zoom;
    await page.evaluate(({ scale, widthMultiplier, heightMultiplier }) => {
      document.body.style.transform = `scale(${scale})`;
      document.body.style.transformOrigin = '0 0';
      document.body.style.width = `${widthMultiplier}%`;
      document.body.style.height = `${heightMultiplier}%`;
    }, { scale, widthMultiplier, heightMultiplier });

    logger.success('Zoom and resize applied successfully.');
  } catch (error) {
    logger.error(`Error in zoomHandler: ${error.message}`);
    throw error;
  }
};