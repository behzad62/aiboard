export function App({ loading }: { loading: boolean }) {
  if (loading) return <p>Loading results</p>;
  return <p>Done</p>;
}
