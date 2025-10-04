import express from "express";
import fetch from "node-fetch";
import fs from "fs/promises";

const app = express();
app.use(express.json());

// Load config
let config = JSON.parse(await fs.readFile("./config.json", "utf8"));

// Global state
let rescheduling = false;
let noDatesLogged = false;
let pollingInterval = null;
let pollingActive = false;

// ---------------------- API FUNCTIONS ----------------------
async function getSlotDates(fromDate, toDate, input) {
  try {
    const resp = await fetch(
      "https://www.usvisaappt.com/visaadministrationapi/v1/modifyslot/getSlotDates",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${input.token}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/plain, */*",
          Origin: "https://www.usvisaappt.com",
          Referer: "https://www.usvisaappt.com/visaapplicantui/home/appointment/slot",
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
        },
        body: JSON.stringify({
          fromDate,
          toDate,
          postUserId: +input.postUserId,
          applicantId: input.applicantId,
          applicationId: input.applicationId,
          locationType: "POST",
          visaClass: input.visaClass,
          visaType: input.visaType,
        }),
      }
    );

    if (resp.status === 401) {
      console.log("⚠️ Token expired. Capture new token to continue.");
      return null;
    }
    if (resp.status === 403) return null;
    if (resp.status === 404) return [];

    const text = await resp.text();
    try {
      const data = JSON.parse(text);
      return Array.isArray(data) ? data : null;
    } catch {
      return null;
    }
  } catch {
    return null;
  }
}

async function getSlotTimes(fromDate, toDate, slotDate, input) {
  try {
    const resp = await fetch(
      "https://www.usvisaappt.com/visaadministrationapi/v1/modifyslot/getSlotTime",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${input.token}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/plain, */*",
          Origin: "https://www.usvisaappt.com",
          Referer: "https://www.usvisaappt.com/visaapplicantui/home/appointment/slot",
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
        },
        body: JSON.stringify({
          fromDate,
          toDate,
          slotDate,
          postUserId: +input.postUserId,
          applicantId: input.applicantId,
          applicationId: input.applicationId,
          visaClass: input.visaClass,
          visaType: input.visaType,
        }),
      }
    );

    if (resp.status === 401) return null;
    const text = await resp.text();
    try {
      const data = JSON.parse(text);
      return Array.isArray(data) ? data : null;
    } catch {
      return null;
    }
  } catch {
    return null;
  }
}

async function rescheduleAppointment(slot, input) {
  const startDate = new Date(slot.startTime);
  const appointmentTime = startDate.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
    timeZone: "UTC",
  });

  const payload = {
    applicantId: input.applicantId,
    applicationId: input.applicationId,
    postUserId: +input.postUserId,
    appointmentId: +input.appointmentId,
    appointmentDt: slot.slotDate,
    appointmentTime,
    slotId: slot.slotId,
    fromDate: input.preferredStartDate,
    toDate: input.preferredEndDate,
    visaType: input.visaType,
    visaClass: input.visaClass,
  };

  const resp = await fetch(
    "https://www.usvisaappt.com/visaappointmentapi/appointments/reschedule",
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${input.token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify([payload]),
    }
  );

  return resp.json();
}

async function tryRescheduleParallel(slots, input) {
  const attempts = slots.map(async (slot) => {
    let retries = 0;
    while (retries < config.maxRetries) {
      retries++;
      console.log(`⚡ Attempting reschedule (slot ${slot.slotId}, try ${retries})`);
      const result = await rescheduleAppointment(slot, input);
      if (result?.status === 409) continue; // retry
      return result;
    }
    return { error: "Max retries reached for slot " + slot.slotId };
  });

  return Promise.any(attempts).catch(() => null);
}

// ---------------------- POLLING ----------------------
async function pollSlots(input) {
  if (rescheduling) return;

  const dates = await getSlotDates(input.preferredStartDate, input.preferredEndDate, input);

  if (!dates || !dates.length) {
    if (!noDatesLogged) {
      console.log("ℹ️ No available dates yet. Continuing silently...");
      noDatesLogged = true;
    }
    return;
  }

  noDatesLogged = false;

  const timesResults = await Promise.all(
    dates.map((d) => {
      const dateString = typeof d === "string" ? d.split("T")[0] : d.date.split("T")[0];
      return getSlotTimes(input.preferredStartDate, input.preferredEndDate, dateString, input);
    })
  );

  const allSlots = timesResults.flat().filter((s) => s.slotStatus === "UNBOOKED");
  if (!allSlots.length) return;

  allSlots.sort((a, b) => new Date(a.startTime) - new Date(b.startTime));
  const bestSlots = allSlots.slice(0, config.parallelAttempts);
  console.log("✅ Found slots:", bestSlots.map((s) => s.slotDate + " " + s.startTime));

  rescheduling = true;
  const result = await tryRescheduleParallel(bestSlots, input);
  console.log("🎉 First successful reschedule result:", result);

  if (!result?.error && !result?.status) {
    stopPolling();
    console.log("🛑 Polling stopped after successful reschedule.");
  } else {
    rescheduling = false;
  }
}

function startPolling(input) {
  if (pollingActive) {
    console.log("⚠️ Polling already running.");
    return;
  }
  const interval = 600;
  console.log(`🚀 Starting ultra-fast polling (every ${interval} ms)...`);
  pollingInterval = setInterval(() => pollSlots(input), interval);
  pollingActive = true;
}

function stopPolling() {
  if (pollingInterval) clearInterval(pollingInterval);
  pollingActive = false;
  rescheduling = false;
  console.log("⏹️ Polling stopped.");
}

// ---------------------- EXPRESS STATUS SERVER ----------------------
app.get("/status", (req, res) => {
  res.json({
    polling: pollingActive,
    rescheduling,
    config,
  });
});

// ---------------------- AUTO START ----------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🌐 Local control server running at http://localhost:${PORT}`);
  console.log("📡 Auto-starting polling...");
  startPolling(config);
});
