// CloudWatch embedded metric format: a log line that CloudWatch turns into a metric, with no API call.
// Each count is published in total and per shop. Lambda logs are read this way automatically; a
// container needs the CloudWatch agent or FireLens for the same lines to become metrics.
// Written straight to stdout: Lambda's JSON log format wraps console output, which would hide the metric.
export function emfMetrics(namespace = 'Astrashop', write = (line) => process.stdout.write(`${line}\n`)) {
  return (name, shopId, value = 1) => write(JSON.stringify({
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [{ Namespace: namespace, Dimensions: shopId ? [[], ['shopId']] : [[]], Metrics: [{ Name: name, Unit: 'Count' }] }],
    },
    ...(shopId ? { shopId } : {}),
    [name]: value,
  }));
}
