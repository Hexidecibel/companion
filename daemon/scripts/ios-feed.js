/*
 * iOS "new build on TestFlight" feed: pure helpers for `publish-update --run`.
 *
 * iOS apps cannot update themselves; CI uploads each release run's IPA to
 * TestFlight with CFBundleVersion = the run's github.run_number. When a run's
 * build-ios job uploaded to TestFlight (the "Upload IPA to TestFlight" step
 * succeeded, not skipped) and the run has the ios-ipa artifact,
 * publish-update writes <feed>/<channel>/ios.json:
 *   { build, versionName, publishedAt, testflightUrl, runId, notes }
 * The iOS app (web/src/hooks/useIosTestflight.ts) compares `build` with its
 * own CFBundleVersion and shows "Build N is on TestFlight".
 */
'use strict';

const MANIFEST = 'ios.json';
const IOS_ARTIFACT = 'ios-ipa';
const IOS_JOB = /^Build iOS\b/;
const TESTFLIGHT_STEP = /TestFlight/i;
const DEFAULT_TESTFLIGHT_URL = 'itms-beta://';

/**
 * Did this run's iOS job upload to TestFlight? `jobs` is `gh run view --json jobs`
 * `.jobs`. True only when the upload step concluded `success` (skipped,
 * failed, cancelled or missing are all false).
 */
function testflightUploaded(jobs) {
  if (!Array.isArray(jobs)) return false;
  const job = jobs.find((j) => j && typeof j.name === 'string' && IOS_JOB.test(j.name));
  if (!job || !Array.isArray(job.steps)) return false;
  const step = job.steps.find(
    (s) => s && typeof s.name === 'string' && TESTFLIGHT_STEP.test(s.name) && /upload/i.test(s.name)
  );
  return Boolean(step && step.conclusion === 'success');
}

/** The TestFlight deep link: the app's page when its Apple ID is known, else TestFlight itself. */
function testflightUrl(appleId) {
  const id = appleId == null ? '' : String(appleId).trim();
  return /^\d{6,12}$/.test(id) ? `itms-beta://beta.itunes.apple.com/v1/app/${id}` : DEFAULT_TESTFLIGHT_URL;
}

/** Throws unless `build` may replace the published entry (never an older build). */
function checkPublishable(current, build) {
  if (!Number.isSafeInteger(build) || build <= 0) throw new Error(`bad iOS build number: ${build}`);
  if (current && Number.isSafeInteger(current.build) && build < current.build) {
    throw new Error(`ios.json already has build ${current.build}; refusing older build ${build}`);
  }
}

function buildIosEntry({ build, versionName, runId, appleId, notes, now }) {
  return {
    build,
    versionName: versionName || '',
    publishedAt: new Date(now).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    testflightUrl: testflightUrl(appleId),
    runId: runId == null ? null : Number(runId),
    notes: notes || `Companion ${versionName ? `${versionName} ` : ''}(build ${build}) is on TestFlight`,
  };
}

/**
 * Should this run publish ios.json? Returns { ok, reason }.
 * `artifacts` = the run's artifact names, `jobs` = gh's jobs list.
 */
function shouldPublishIos({ artifacts, jobs }) {
  if (!Array.isArray(artifacts) || !artifacts.includes(IOS_ARTIFACT))
    return { ok: false, reason: `no ${IOS_ARTIFACT} artifact` };
  if (!testflightUploaded(jobs)) return { ok: false, reason: 'TestFlight upload was skipped or did not succeed' };
  return { ok: true, reason: '' };
}

module.exports = {
  MANIFEST,
  IOS_ARTIFACT,
  DEFAULT_TESTFLIGHT_URL,
  testflightUploaded,
  testflightUrl,
  checkPublishable,
  buildIosEntry,
  shouldPublishIos,
};
