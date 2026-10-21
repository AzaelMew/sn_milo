// Local instance configuration. No credentials are stored here.
globalThis.SnTimecardConfig = {
  instances: [
    {origin: 'https://exampletest.service-now.com', mode: 'test', enableSubmission: true},
    {origin: 'https://example.service-now.com', mode: 'production', enableSubmission: true}
  ]
};
