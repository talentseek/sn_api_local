// Utility function to add working days (excluding weekends) to a timestamp
const addWorkingDays = (startDate, days) => {
  let currentDate = new Date(startDate);
  let daysAdded = 0;

  while (daysAdded < days) {
    currentDate.setDate(currentDate.getDate() + 1);
    const dayOfWeek = currentDate.getDay();
    // Skip Saturday (6) and Sunday (0)
    if (dayOfWeek !== 0 && dayOfWeek !== 6) {
      daysAdded++;
    }
  }

  // If the resulting date is a weekend, move to the next Monday
  while (currentDate.getDay() === 0 || currentDate.getDay() === 6) {
    currentDate.setDate(currentDate.getDate() + 1);
  }

  return currentDate;
};

// Utility function to check if the delay period has passed
const hasDelayPassed = (lastContacted, delayDays) => {
  if (!lastContacted || !delayDays) return true; // No delay check for stage 1
  const requiredDate = addWorkingDays(new Date(lastContacted), delayDays);
  return new Date() >= requiredDate;
};

module.exports = {
  addWorkingDays,
  hasDelayPassed,
};