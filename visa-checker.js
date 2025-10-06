import express from "express";
import fetch from "node-fetch";
import fs from "fs";

const app = express();
const PORT = process.env.PORT || 3000;

// Load configuration
const config = JSON.parse(fs.readFileSync("./config.json", "utf8"));

const {
  token,
  applicantId,
  applicationId,
  postUserId,
  visaType,
  visaClass,
  appointmentId,
  pollInterval,
  parallelAttempts,
  maxRetries,
  preferredStartDate,
  preferredEndDate,
} = config;

// Core API URLs
const API_BASE = "https://www.usvisaappt.com/visaappointmentapi";
const RESCHEDULE_URL = `${API_BASE}/appointments/reschedule`;
const AVAILABLE_SLOTS_URL = `${API_BASE}/slots/available`;

let pollingActive = true;

/**
 * Fetch available slots for your visa type and post location
 */
async function fetchAvailableSlots() {
  const url = `${AVAILABLE_SLOTS_URL}?appointmentId=${appointmentId}&postUserId=${postUserId}&visaType=${visaType}&visaClass=${visaClass}`;

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });

  if (!res.ok) {
    console.error("❌ Failed to fetch slots:", res.status, await res.text());
    return [];
  }

  const data = await res.json();
  return data?.slots || [];
}

/**
 * Attempt to reschedule appointment
 */
async function attemptReschedule(slotId, appointmentDt, appointmentTime) {
  const payload = [
    {
      appointmentId,
      applicantId,
      applicationId,
      postUserId,
      appointmentLocationType: "POST",
      appointmentDt,
      appointmentTime,
      rescheduleType: "POST",
      slotId,
      appointmentStatus: "SCHEDULED",
      applicantUUID: null,
    },
  ];

  const res = await fetch(RESCHEDULE_URL, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(payload),
  });

  const text = await res.text();
  console.log(`⚡ Reschedule Response (${res.status}):`, text);

  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Main polling function
 */
async function pollForSlots() {
  let retries = 0;

  while (pollingActive) {
    try {
      const slots = await fetchAvailableSlots();
      const validSlots = slots.filter((s) => {
        const date = new Date(s.appointmentDt);
        return (
          date >= new Date(preferredStartDate) &&
          date <= new Date(preferredEndDate)
        );
      });

      if (validSlots.length > 0) {
        console.log("✅ Found slots:", validSlots.map((s) => `${s.appointmentDt} ${s.appointmentTime}`));

        for (let i = 0; i < Math.min(parallelAttempts, validSlots.length); i++) {
          const slot = validSlots[i];
          console.log(`⚡ Attempting reschedule (slot ${slot.slotId}, try ${retries + 1})`);
          const result = await attemptReschedule(slot.slotId, slot.appointmentDt, slot.appointmentTime);

          if (result && result[0]?.appointmentStatus === "SCHEDULED") {
            console.log("🎉 Successfully rescheduled:", result[0]);
            pollingActive = false;
            console.log("⏹️ Polling stopped after successful reschedule.");
            return;
          }
        }
      } else {
        console.log("⏳ No suitable slots found yet...");
      }
    } catch (err) {
      console.error("⚠️ Error in polling loop:", err);
    }

    retries++;
    if (retries >= maxRetries) {
      console.log("🛑 Max retries reached. Stopping polling.");
      pollingActive = false;
      break;
    }

    await new Promise((r) => setTimeout(r, pollInterval * 1000));
  }
}

// Express endpoint for status
app.get("/", (req, res) => {
  res.send(
    pollingActive
      ? "🤖 Visa Checker Bot is running and polling for slots..."
      : "✅ Visa Checker Bot has stopped polling."
  );
});

// Start server and polling
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  pollForSlots();
});
