class BirdsongMicrophone extends AudioWorkletProcessor {
  constructor() {
    super();
    this.block=new Float32Array(Math.round(sampleRate*.16));
    this.position=0;
  }
  process(inputs) {
    const channels=inputs[0];
    if (!channels?.length) return true;
    for (let i=0;i<channels[0].length;i++) {
      let sample=0;
      for (const channel of channels) sample+=channel[i];
      this.block[this.position++]=sample/channels.length;
      if (this.position===this.block.length) {
        this.port.postMessage(this.block,[this.block.buffer]);
        this.block=new Float32Array(Math.round(sampleRate*.16));
        this.position=0;
      }
    }
    return true;
  }
}

registerProcessor('birdsong-microphone',BirdsongMicrophone);
