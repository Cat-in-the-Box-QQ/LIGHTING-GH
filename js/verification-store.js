// verification-store.js - access verification metadata generated offline

const VerificationStore = (() => {
  let log = [];
  let summary = null;
  let sources = [];

  async function load() {
    const [logRes, summaryRes, sourcesRes] = await Promise.all([
      fetch('data/verification_log.json', { cache: 'no-store' }),
      fetch('data/verification_summary.json', { cache: 'no-store' }),
      fetch('data/sources.json', { cache: 'no-store' }),
    ]);

    log = await logRes.json();
    summary = await summaryRes.json();
    sources = await sourcesRes.json();
    return { log, summary, sources };
  }

  function getLogByFixtureId(id) {
    return log.find((item) => Number(item.id) === Number(id)) || null;
  }

  function getSourceById(id) {
    return sources.find((item) => item.id === id) || null;
  }

  function getSummary() {
    return summary;
  }

  function getAllLogs() {
    return [...log];
  }

  return { load, getLogByFixtureId, getSourceById, getSummary, getAllLogs };
})();
