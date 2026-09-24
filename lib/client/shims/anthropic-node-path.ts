const unavailable = () => {
  throw new Error(
    "Anthropic local credential paths are unavailable in the browser; pass apiKey or authToken."
  );
};

export const join = unavailable;
export const dirname = unavailable;
