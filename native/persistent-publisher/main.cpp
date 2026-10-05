// One demux/remux output for the entire Demo. Never opens a decoder or encoder.
#include <algorithm>
#include <atomic>
#include <csignal>
#include <cstring>
#include <iostream>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>
#include <unistd.h>
#include <sys/resource.h>
#include <json-c/json.h>
extern "C" {
#include <libavformat/avformat.h>
#include <libavcodec/avcodec.h>
#include <libavutil/time.h>
#include <libavutil/pixfmt.h>
}
using Json = std::unique_ptr<json_object, decltype(&json_object_put)>;
static std::atomic<bool> stopping{false};
static std::atomic<int64_t> writeDeadline{0};
static std::mutex eventsMutex;
static int interrupt(void*) { return stopping || (writeDeadline && av_gettime_relative() >= writeDeadline); }
static void check(int code) { if (code < 0) throw std::runtime_error("media_operation_failed"); }
static std::string field(json_object* j, const char* name) {
  json_object* value = nullptr;
  if (!json_object_object_get_ex(j, name, &value) || !json_object_is_type(value, json_type_string))
    throw std::runtime_error("invalid_command");
  return json_object_get_string(value);
}
static Json parse(const std::string& line) {
  if (line.size() > 16384) throw std::runtime_error("command_too_large");
  Json j(json_tokener_parse(line.c_str()), json_object_put);
  if (!j || !json_object_is_type(j.get(), json_type_object)) throw std::runtime_error("invalid_command");
  return j;
}
static void event(const char* type, const std::string& id = "", double timestamp = 0, const char* reason = nullptr) {
  Json j(json_object_new_object(), json_object_put);
  json_object_object_add(j.get(), "event", json_object_new_string(type));
  json_object_object_add(j.get(), "requestId", json_object_new_string(id.c_str()));
  json_object_object_add(j.get(), "outputTimestamp", json_object_new_double(timestamp));
  if (std::strcmp(type,"progress") == 0) {
    struct rusage usage{}; getrusage(RUSAGE_SELF,&usage);
#ifdef __APPLE__
    const int64_t bytes = usage.ru_maxrss;
#else
    const int64_t bytes = int64_t(usage.ru_maxrss) * 1024;
#endif
    json_object_object_add(j.get(), "peakRssBytes", json_object_new_int64(bytes));
  }
  if (reason) json_object_object_add(j.get(), "reason", json_object_new_string(reason));
  std::lock_guard<std::mutex> lock(eventsMutex);
  std::cout << json_object_to_json_string_ext(j.get(), JSON_C_TO_STRING_PLAIN) << std::endl;
}
static bool idr(const AVPacket* p, int lengthSize) {
  for (int at = 0; at < p->size;) {
    if (at + lengthSize > p->size) return false;
    unsigned length = 0;
    for (int i = 0; i < lengthSize; ++i) length = (length << 8) | p->data[at++];
    if (!length || length > unsigned(p->size - at)) return false;
    if ((p->data[at] & 31) == 5) return true;
    at += int(length);
  }
  return false;
}
struct Bits {
  std::vector<uint8_t> data; size_t bit = 0;
  Bits(const uint8_t* p, size_t count) {
    int zeros = 0;
    for (size_t i = 0; i < count; ++i) {
      if (zeros >= 2 && p[i] == 3) { zeros = 0; continue; }
      data.push_back(p[i]); zeros = p[i] == 0 ? zeros + 1 : 0;
    }
  }
  unsigned read(int count) {
    if (bit + count > data.size() * 8) throw std::runtime_error("invalid_sps");
    unsigned n = 0;
    while (count--) { n = (n << 1) | ((data[bit/8] >> (7-bit%8)) & 1); ++bit; }
    return n;
  }
  unsigned ue() {
    int zeros = 0;
    while (!read(1)) { if (++zeros > 30) throw std::runtime_error("invalid_sps"); }
    return ((1U << zeros) - 1) + read(zeros);
  }
};
static void verifySps(const AVCodecParameters* v) {
  const auto* p = v->extradata;
  const size_t size = v->extradata_size;
  if ((p[5] & 31) != 1 || size < 8) throw std::runtime_error("invalid_sps");
  const size_t length = (unsigned(p[6]) << 8) | p[7];
  if (length < 4 || length + 8 > size || (p[8] & 31) != 7) throw std::runtime_error("invalid_sps");
  Bits b(p+9,length-1);
  if (b.read(8) != 77) throw std::runtime_error("main_profile_required");
  b.read(8);
  if (b.read(8) != 32) throw std::runtime_error("level_32_required");
  b.ue(); b.ue(); // SPS id and frame number bits
  const unsigned poc = b.ue();
  if (poc == 0) b.ue();
  else if (poc != 2) throw std::runtime_error("unsupported_poc");
  if (b.ue() != 1) throw std::runtime_error("one_reference_required");
  if (b.read(1)) throw std::runtime_error("frame_number_gaps");
  unsigned width = (b.ue()+1)*16, height = (b.ue()+1)*16;
  if (!b.read(1)) throw std::runtime_error("progressive_required");
  b.read(1);
  if (b.read(1)) { const unsigned left=b.ue(),right=b.ue(),top=b.ue(),bottom=b.ue(); width-=2*(left+right);height-=2*(top+bottom); }
  if (width!=800 || height!=800) throw std::runtime_error("square_800_required");
  if (b.read(1) && b.read(1)) {
    const unsigned aspect=b.read(8);
    if (aspect==255) { const unsigned num=b.read(16),den=b.read(16); if(!num || num!=den) throw std::runtime_error("square_pixels_required"); }
    else if (aspect!=1) throw std::runtime_error("square_pixels_required");
  }
}
struct PacketDelete { void operator()(AVPacket* p) const { av_packet_free(&p); } };
using Packet = std::unique_ptr<AVPacket, PacketDelete>;
struct Input {
  AVFormatContext* ctx = nullptr;
  int video = -1, audio = -1, lengthSize = 4;
  int64_t frames = 0;
  int64_t firstAudio = AV_NOPTS_VALUE;
  explicit Input(const std::string& path) {
    if (path.empty() || path[0] != '/' || path.find('\0') != std::string::npos) throw std::runtime_error("local_path_required");
    AVDictionary* opts = nullptr;
    av_dict_set(&opts, "protocol_whitelist", "file", 0);
    const int opened = avformat_open_input(&ctx, path.c_str(), nullptr, &opts);
    av_dict_free(&opts);
    check(opened);
    try {
      // Prepared MP4 headers and SPS contain the contract; do not probe by decoding.
      for (unsigned i = 0; i < ctx->nb_streams; ++i) {
        if (ctx->streams[i]->codecpar->codec_type == AVMEDIA_TYPE_VIDEO) { if (video >= 0) throw std::runtime_error("extra_track"); video = i; }
        if (ctx->streams[i]->codecpar->codec_type == AVMEDIA_TYPE_AUDIO) { if (audio >= 0) throw std::runtime_error("extra_track"); audio = i; }
      }
      if (video < 0 || audio < 0 || ctx->nb_streams != 2) throw std::runtime_error("both_tracks_required");
      auto* v = ctx->streams[video]->codecpar;
      auto* a = ctx->streams[audio]->codecpar;
      if (v->codec_id != AV_CODEC_ID_H264 || v->width != 800 || v->height != 800
          || v->bit_rate <= 0 || v->bit_rate > 3500000 || v->extradata_size < 7 || v->extradata[0] != 1
          || a->codec_id != AV_CODEC_ID_AAC || a->sample_rate != 44100
          || a->ch_layout.nb_channels != 2 || a->extradata_size < 2)
        throw std::runtime_error("incompatible_profile");
      if ((a->extradata[0] >> 3) != 2 || (((a->extradata[0] & 7) << 1) | (a->extradata[1] >> 7)) != 4
          || ((a->extradata[1] >> 3) & 15) != 2) throw std::runtime_error("aac_lc_stereo_required");
      lengthSize = (v->extradata[4] & 3) + 1;
      verifySps(v);
      scan();
      rewind();
    } catch (...) { avformat_close_input(&ctx); throw; }
  }
  ~Input() { avformat_close_input(&ctx); }
  Packet next() {
    Packet p(av_packet_alloc()); if (!p) throw std::runtime_error("allocation_failed");
    const int result = av_read_frame(ctx, p.get());
    if (result == AVERROR_EOF) return {};
    check(result); return p;
  }
  void scan() {
    int64_t lastAudio = AV_NOPTS_VALUE, audioEnd = 0;
    while (auto p = next()) {
      if (stopping) throw std::runtime_error("stopped");
      if (p->pts == AV_NOPTS_VALUE || p->dts == AV_NOPTS_VALUE || p->duration <= 0) throw std::runtime_error("invalid_timestamps");
      if (p->stream_index == video) {
        auto tb = ctx->streams[video]->time_base;
        const double time = p->pts * av_q2d(tb);
        if (p->pts != p->dts || std::abs(time - double(frames) / 30) > 0.0001
            || std::abs(p->duration * av_q2d(tb) - 1.0 / 30) > 0.0001)
          throw std::runtime_error("non_cfr_or_b_frames");
        if (bool(p->flags & AV_PKT_FLAG_KEY) != (frames % 60 == 0) || (frames % 60 == 0 && !idr(p.get(), lengthSize)))
          throw std::runtime_error("closed_gop_required");
        ++frames;
      } else if (p->pts >= 0) {
        auto tb = ctx->streams[audio]->time_base;
        const auto sample = av_rescale_q(p->pts, tb, AVRational{1,44100});
        if (p->pts != p->dts || (lastAudio != AV_NOPTS_VALUE && sample != lastAudio + 1024))
          throw std::runtime_error("invalid_audio_timestamps");
        if (firstAudio == AV_NOPTS_VALUE) firstAudio = sample;
        lastAudio = sample;
        audioEnd = sample + av_rescale_q(p->duration, tb, AVRational{1,44100});
      }
    }
    if (!frames || frames % 60 || frames > 108000 || firstAudio != 0
        || std::abs(double(audioEnd) / 44100 - double(frames) / 30) > 0.0233)
      throw std::runtime_error("unsafe_loop_boundary");
  }
  void rewind() {
    check(avformat_seek_file(ctx, video, INT64_MIN, 0, 0, AVSEEK_FLAG_BACKWARD));
    avformat_flush(ctx);
  }
  void compatible(const Input& base) const {
    for (auto pair : {std::pair<int,int>{video,base.video}, {audio,base.audio}}) {
      auto* a = ctx->streams[pair.first]->codecpar;
      auto* b = base.ctx->streams[pair.second]->codecpar;
      if (a->extradata_size != b->extradata_size || std::memcmp(a->extradata,b->extradata,a->extradata_size))
        throw std::runtime_error("decoder_configuration_mismatch");
    }
  }
};
struct Pending { std::string id; std::shared_ptr<Input> input; };
static std::mutex controlMutex;
static std::shared_ptr<Pending> pending;
static std::string committedId;
static double committedTime = 0;
static std::string cancelledId;
static std::string committingId;
static bool preparing = false;
static void controls(std::shared_ptr<Input> base) {
  std::string line;
  while (!stopping && std::getline(std::cin, line)) {
    std::string request;
    try {
      auto j = parse(line);
      const auto type = field(j.get(), "type");
      request = field(j.get(), "requestId");
      if (request.empty() || request.size() > 128) throw std::runtime_error("invalid_request_id");
      if (type == "stop") { stopping = true; break; }
      if (type == "cancel") {
        std::lock_guard<std::mutex> lock(controlMutex);
        if (committedId == request) event("switch_committed",request,committedTime);
        else if (committingId == request) { /* Output owns it; wait for committed receipt. */ }
        else { if (pending && pending->id == request) pending.reset(); cancelledId = request; event("cancelled", request); }
      } else if (type == "switch") {
        {
          std::lock_guard<std::mutex> lock(controlMutex);
          if (pending || preparing) throw std::runtime_error("publisher_busy");
          preparing = true;
        }
        // Input scanning happens off the output thread: current packets continue.
        auto next = std::make_shared<Input>(field(j.get(), "path"));
        next->compatible(*base);
        std::lock_guard<std::mutex> lock(controlMutex);
        preparing = false;
        if (!stopping && cancelledId != request) pending = std::make_shared<Pending>(Pending{request,next});
      } else throw std::runtime_error("invalid_command");
    } catch (const std::exception& e) {
      std::lock_guard<std::mutex> lock(controlMutex);
      preparing = false;
      event("switch_rejected",request,0,e.what());
    }
  }
  stopping = true;
}
struct Output {
  AVFormatContext* ctx = nullptr;
  explicit Output(Input& base, const std::string& url, bool local) {
    if (!local && url.rfind("rtmps://",0) != 0) throw std::runtime_error("rtmps_required");
    if (local && (url.empty() || url[0] != '/')) throw std::runtime_error("local_path_required");
    check(avformat_alloc_output_context2(&ctx,nullptr,"flv",url.c_str()));
    ctx->interrupt_callback = {interrupt,nullptr};
    try {
      for (int i : {base.video,base.audio}) {
        auto* stream = avformat_new_stream(ctx,nullptr);
        if (!stream) throw std::runtime_error("allocation_failed");
        check(avcodec_parameters_copy(stream->codecpar,base.ctx->streams[i]->codecpar));
        stream->codecpar->codec_tag = 0;
        stream->time_base = {1,1000};
      }
      AVDictionary* options = nullptr;
      av_dict_set(&options,"rw_timeout","5000000",0);
      writeDeadline = av_gettime_relative() + 5000000;
      const int opened = avio_open2(&ctx->pb,url.c_str(),AVIO_FLAG_WRITE,&ctx->interrupt_callback,&options);
      av_dict_free(&options); check(opened);
      check(avformat_write_header(ctx,nullptr));
      writeDeadline = 0;
    } catch (...) { if (ctx->pb) avio_closep(&ctx->pb); avformat_free_context(ctx); ctx=nullptr; throw; }
  }
  void write(AVPacket* p) {
    writeDeadline = av_gettime_relative() + 5000000;
    check(av_interleaved_write_frame(ctx,p));
    avio_flush(ctx->pb);
    check(ctx->pb->error);
    writeDeadline = 0;
  }
  ~Output() {
    if (ctx) {
      writeDeadline = av_gettime_relative() + 5000000;
      av_write_trailer(ctx);
      avio_closep(&ctx->pb); avformat_free_context(ctx);
    }
  }
};
static void run(std::shared_ptr<Input> base, const std::string& url, bool local) {
  Output output(*base,url,local);
  auto current = base;
  int64_t videoFrames = 0, audioSamples = 0, localFrames = 0, segmentStart = 0;
  std::string awaitingCommit;
  const int64_t began = av_gettime_relative();
  int64_t progressAt = began;
  std::thread reader(controls,base);
  reader.detach(); // main exits the process after output teardown; stdin may still be blocked.
  event("ready");
  while (!stopping) {
    auto packet = current->next();
    bool boundary = !packet || (packet->stream_index == current->video && localFrames > 0 && (packet->flags & AV_PKT_FLAG_KEY));

    if (boundary) {
      std::lock_guard<std::mutex> lock(controlMutex);
      if (pending) {
        current = pending->input; awaitingCommit = pending->id; committingId = awaitingCommit; pending.reset();
        segmentStart = videoFrames;
        localFrames = 0; packet = current->next();
      } else if (!packet) { segmentStart = videoFrames; current->rewind(); localFrames = 0; packet = current->next(); }
    }
    if (!packet) throw std::runtime_error("empty_asset");
    if (packet->stream_index == current->audio && packet->pts < 0) continue; // MP4 priming packet
    const bool video = packet->stream_index == current->video;
    if (!video) {
      const double desired = double(segmentStart) / 30 + packet->pts * av_q2d(current->ctx->streams[current->audio]->time_base);
      if (desired < double(audioSamples) / 44100 - 512.0 / 44100) continue;
    }
    // Trim end padding. Full AAC packets maintain one global sample grid across switches.
    if (!video && packet->pts * av_q2d(current->ctx->streams[current->audio]->time_base) >= double(current->frames)/30) continue;
    const auto timeBase = video ? AVRational{1,30} : AVRational{1,44100};
    const int64_t units = video ? videoFrames : audioSamples;
    const int64_t micros = av_rescale_q(units,timeBase,AVRational{1,1000000});
    while (!stopping && av_gettime_relative() < began + micros) av_usleep(1000);
    if (stopping) break;
    packet->stream_index = video ? 0 : 1;
    packet->pts = packet->dts = units;
    packet->duration = video ? 1 : 1024;
    av_packet_rescale_ts(packet.get(),timeBase,output.ctx->streams[packet->stream_index]->time_base);
    packet->pos = -1;
    output.write(packet.get());
    if (video) { ++videoFrames; ++localFrames; } else audioSamples += 1024;
    if (!awaitingCommit.empty() && video) {
      // Acknowledge only after the incoming IDR has reached the output writer.
      std::lock_guard<std::mutex> lock(controlMutex);
      committedId = awaitingCommit; committingId.clear(); awaitingCommit.clear(); committedTime = double(videoFrames-1)/30;
      event("switch_committed",committedId,committedTime);
    }
    const auto now = av_gettime_relative();
    if (now - progressAt >= 500000) { event("progress","",double(videoFrames)/30); progressAt=now; }
  }
}
int main(int argc, char** argv) {
  av_log_set_level(AV_LOG_QUIET); // libav can include ingest credentials in errors
  if (argc == 2 && std::string(argv[1]) == "--version") {
    std::cout << "{\"protocol\":1,\"avformat\":" << avformat_version() << ",\"avcodec\":" << avcodec_version()
      << ",\"avutil\":" << avutil_version() << ",\"jsonC\":\"" << json_c_version() << "\"}" << std::endl;
    return 0;
  }
  std::signal(SIGTERM, [](int){ stopping=true; }); std::signal(SIGINT, [](int){ stopping=true; }); std::signal(SIGPIPE,SIG_IGN);
  try {
    std::string line;
    if (!std::getline(std::cin,line)) throw std::runtime_error("missing_start");
    auto j = parse(line);
    const auto type = field(j.get(),"type");
    auto base = std::make_shared<Input>(field(j.get(),"path"));
    if (type == "validate") { event("valid"); return 0; }
    if (type != "start") throw std::runtime_error("invalid_start");
    const bool local = argc == 2 && std::string(argv[1]) == "--local-test";
    run(base,field(j.get(),"output"),local);
    event("stopped");
    // detached stdin worker must not outlive process-global synchronization objects
    std::cout.flush(); _Exit(0);
  } catch (const std::exception& e) { event("fatal","",0,e.what()); std::cout.flush(); _Exit(1); }
}
