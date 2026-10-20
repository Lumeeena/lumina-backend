-- Maps pino's numeric level to a name. Unknown values are left as they are, so
-- a new pino level shows up as a number rather than disappearing.
local names = {
  [10] = "trace",
  [20] = "debug",
  [30] = "info",
  [40] = "warn",
  [50] = "error",
  [60] = "fatal",
}

function map_level(tag, timestamp, record)
  local level = tonumber(record["level"])
  if level ~= nil and names[level] ~= nil then
    record["level"] = names[level]
    return 1, timestamp, record
  end
  return 1, timestamp, record
end
