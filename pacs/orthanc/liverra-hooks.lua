-- LiverRa Orthanc Lua hooks — edge-appliance integration with the
-- anonymization sidecar running on localhost:7070.
--
-- Plain-English:
--   Every time a DICOM scanner pushes an instance into Orthanc, this script
--   intercepts it BEFORE it is persisted to disk / Postgres. We POST a tiny
--   metadata snapshot (NOT pixel data) to the sidecar's /orthanc-webhook
--   endpoint. The sidecar orchestrates the three anonymization gates
--   (UTF-8 NFC → CTP header scrub → Presidio burned-in pixel scan) and
--   replies with allow (HTTP 200) or block (any other status). Blocked
--   instances are rejected; the scanner receives a DIMSE failure.
--
-- References:
--   - specs/001-zero-training-mvp/research.md §B.3
--   - spec.md §FR-002 / §FR-002a
--
-- PHI safety: we do NOT log PatientName / PatientID / any identifying tag.
-- Only the SOP Instance UID, SOP Class UID, and Study Instance UID appear
-- in logs — these are DICOM infrastructure identifiers, not PHI.

-- Sidecar URL is read from env. Leaving LIVERRA_ANON_SIDECAR_URL unset (or
-- empty) disables the webhook entirely and accepts every instance — intended
-- for local dev where there is no sidecar. Production MUST set this so the
-- fail-closed path in FR-002 engages.
local SIDECAR_URL = os.getenv('LIVERRA_ANON_SIDECAR_URL') or ''

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- Redact any field in a DICOM tag-dict that could carry PHI. We keep only
-- the infrastructure identifiers the sidecar needs to make a decision.
local function buildMetadata(instance)
  local tags = instance.Tags or {}
  return {
    SOPInstanceUID = tags.SOPInstanceUID,
    SOPClassUID = tags.SOPClassUID,
    StudyInstanceUID = tags.StudyInstanceUID,
    SeriesInstanceUID = tags.SeriesInstanceUID,
    Modality = tags.Modality,
    -- Charset hint — the sidecar uses this to pick the right UTF-8 decoder.
    SpecificCharacterSet = tags.SpecificCharacterSet,
    -- The sidecar needs the instance length to size its PHI scan budget.
    SizeBytes = instance.Size,
    -- The Orthanc instance ID lets the sidecar re-fetch the full payload
    -- from Orthanc's REST API once it decides to allow the instance.
    OrthancInstanceId = instance.OrthancID
  }
end

local function safeInstanceId(instance)
  -- Short form of the SOP UID for logging — never PHI.
  local uid = (instance.Tags and instance.Tags.SOPInstanceUID) or 'unknown'
  if #uid > 24 then
    return uid:sub(-12)
  end
  return uid
end

-- ---------------------------------------------------------------------------
-- Hook: ReceivedInstanceFilter
-- ---------------------------------------------------------------------------
--
-- Called for every instance received via DIMSE C-STORE or the REST POST
-- /instances. Returning `false` rejects the instance.

function ReceivedInstanceFilter(instance)
  if SIDECAR_URL == '' then
    print(string.format(
      '[liverra-hooks] sidecar disabled (LIVERRA_ANON_SIDECAR_URL unset); allowing %s',
      safeInstanceId(instance)
    ))
    return true
  end

  local ok, payload = pcall(function()
    return DumpJson(buildMetadata(instance), true)
  end)
  if not ok or payload == nil then
    print(string.format(
      '[liverra-hooks] failed to serialize instance metadata for %s; rejecting fail-closed',
      safeInstanceId(instance)
    ))
    return false
  end

  -- HttpPost raises on transport failure; wrap in pcall so the handler is
  -- deterministic. Anything that isn't a clean 2xx → reject (fail-closed
  -- per spec §FR-002).
  local response
  local httpOk
  httpOk, response = pcall(function()
    return HttpPost(
      SIDECAR_URL,
      payload,
      { ['Content-Type'] = 'application/json' }
    )
  end)

  if not httpOk then
    print(string.format(
      '[liverra-hooks] sidecar unreachable; rejecting instance %s fail-closed',
      safeInstanceId(instance)
    ))
    return false
  end

  -- HttpPost returns the response body on 2xx; on non-2xx it raises, so
  -- reaching here means 200 OK. The sidecar may still return `{"allow":false}`
  -- in the body if it wants the instance dropped.
  local parsedOk, parsed = pcall(function()
    return ParseJson(response)
  end)
  if not parsedOk or type(parsed) ~= 'table' then
    print(string.format(
      '[liverra-hooks] sidecar returned unparseable body for %s; rejecting',
      safeInstanceId(instance)
    ))
    return false
  end

  if parsed.allow == false then
    -- Sidecar has already scheduled crypto-shred + emitted an AuditEvent;
    -- we just refuse the instance here.
    print(string.format(
      '[liverra-hooks] sidecar denied instance %s (reason_slug=%s)',
      safeInstanceId(instance),
      parsed.reason or 'unspecified'
    ))
    return false
  end

  return true
end

-- Optional hook invoked after an instance has been successfully stored; we
-- use it only for an infrastructure-level telemetry line.
function OnStoredInstance(instanceId, tags, metadata)
  print(string.format(
    '[liverra-hooks] stored instance (orthanc_id=%s, sop_short=%s)',
    instanceId,
    safeInstanceId({ Tags = tags })
  ))
end
