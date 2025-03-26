module.exports = {
  headless: true, // Headless mode for better performance
  viewport: {
    width: 1920, // Standard HD resolution
    height: 1080,
    deviceScaleFactor: 1,
  },
  zoom: {
    scale: 1, // No scaling needed with a standard viewport
    widthMultiplier: 100,
    heightMultiplier: 100,
  },
};