class BirdsongMicrophone extends AudioWorkletProcessor {
  constructor() {
    super();
    this.blockSize=Math.round(sampleRate*.08);
    this.block=new Float32Array(this.blockSize);
    this.position=0;
    this.startSample=0;
  }
  process(inputs) {
    const channels=inputs[0];
    if (!channels?.length) return true;
    for (let i=0;i<channels[0].length;i++) {
      let sample=0;
      for (const channel of channels) sample+=channel[i];
      this.block[this.position++]=sample/channels.length;
      if (this.position===this.block.length) {
        this.port.postMessage({samples:this.block,startSample:this.startSample},[this.block.buffer]);
        this.startSample+=this.blockSize;
        this.block=new Float32Array(this.blockSize);
        this.position=0;
      }
    }
    return true;
  }
}

registerProcessor('birdsong-microphone',BirdsongMicrophone);
