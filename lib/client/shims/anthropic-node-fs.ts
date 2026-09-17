const unavailable = () => {
  throw new Error(
    "Anthropic local credential files are unavailable in the browser; pass apiKey or authToken."
  );
};

export const promises = new Proxy(Object.create(null), {
  get: () => unavailable,
});
