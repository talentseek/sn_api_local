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

// Utility function to check if the delay period has passed using working days
const hasDelayPassed = (lastContacted, delayDays) => {
  if (!lastContacted) return false; // If never contacted, delay hasn't passed (for stages > 1)
  if (!delayDays || delayDays <= 0) return true; // No delay required or stage 1
  
  const lastContactedDate = new Date(lastContacted);
  // Calculate the date when the lead is eligible for the next message using working days
  const eligibleDate = addWorkingDays(lastContactedDate, delayDays);
  
  // Check if the current date is on or after the eligible date
  return new Date() >= eligibleDate;
};

module.exports = {
  addWorkingDays,
  hasDelayPassed,
};