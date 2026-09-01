import { ExperimentBuilder } from "@/components/experiment-builder";

export default function HomePage() {
  return (
    <main className="page-shell">
      <section className="intro">
        <p className="eyebrow">Blind prompt-identification benchmark</p>
        <h1>Do words leave a detectable signature?</h1>
        <p>
          Generate source code under neighboring qualitative instructions, then ask fresh Codex threads to identify the hidden word and score what changed. This measures observable behavior. It does not claim to reveal a model&apos;s hidden definition.
        </p>
      </section>
      <ExperimentBuilder />
    </main>
  );
}
