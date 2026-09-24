// Test-only recorder: stamp both audio paths using the same AudioContext clock.
class SampleTapProcessor extends AudioWorkletProcessor {
  process(inputs, outputs) {
    const samples = inputs[0]?.[0];
    if (samples) this.port.postMessage({ frame: currentFrame, samples: new Float32Array(samples) });
    for (const channel of outputs[0] ?? []) channel.fill(0);
    return true;
  }
}
registerProcessor('sample-tap', SampleTapProcessor);