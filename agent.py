import logging
import os

from dotenv import load_dotenv
from livekit import agents
from livekit.agents import (
    Agent,
    AgentServer,
    AgentSession,
    JobContext,
    TurnHandlingOptions,
    room_io,
)
from livekit.plugins import groq, noise_cancellation, silero
from livekit.agents import inference
from livekit.agents import AgentStateChangedEvent, MetricsCollectedEvent, metrics
import time
import httpx
from livekit.agents import function_tool, RunContext, ToolError
from livekit.agents import AgentTask, function_tool
from livekit.agents.beta.workflows import TaskGroup
from livekit.agents import AgentTask, function_tool, RunContext
from dataclasses import dataclass
from livekit.agents import function_tool, RunContext, get_job_context

@function_tool()
async def transfer_to_human(self, context: RunContext) -> None:
    """Transfer the call to a human agent."""
    context.disallow_interruptions()
    
    await context.session.say(
        "I'm transferring you to a human agent now. Please hold."
    )
    
    room = get_job_context().room
    await room.local_participant.publish_sip_participant(
        sip_trunk_id="your-trunk-id",
        dial_to="sip:support@your-pbx.com",
    )


# Define result types for each task
@dataclass
class EmailResult:
    email_address: str

@dataclass 
class AddressResult:
    address: str

# Task to collect email
class GetEmailTask(AgentTask[EmailResult]):
    def __init__(self) -> None:
        super().__init__(
            instructions="Collect the user's email address."
        )
    
    @function_tool()
    async def record_email(self, context: RunContext, email: str) -> None:
        """Record the user's email address"""
        self.complete(EmailResult(email_address=email))

# Task to collect shipping address
class GetAddressTask(AgentTask[AddressResult]):
    def __init__(self) -> None:
        super().__init__(
            instructions="Collect the user's shipping address."
        )
    
    @function_tool()
    async def record_address(self, context: RunContext, address: str) -> None:
        """Record the user's shipping address"""
        self.complete(AddressResult(address=address))

# Agent that uses the task group
class CheckoutAgent(Agent):
    async def on_enter(self) -> None:
        task_group = TaskGroup()
        
        # Each task wrapped in lambda so it can be reinitialized if user goes back
        task_group.add(
            lambda: GetEmailTask(), 
            id="email", 
            description="Collect email address"
        )
        task_group.add(
            lambda: GetAddressTask(), 
            id="address", 
            description="Collect shipping address"
        )
        
        # Run tasks in sequence
        results = await task_group
        
        # Access results by task ID
        email = results.task_results["email"].email_address
        address = results.task_results["address"].address
        
        await self.session.generate_reply(
            instructions=f"Confirm the order will be sent to {email} at {address}."
        )



logger = logging.getLogger(__name__)

load_dotenv()

class CollectConsent(AgentTask[bool]):
    def __init__(self, chat_ctx=None):
        super().__init__(
            instructions="""
            Ask for recording consent and get a clear yes or no answer.
            Be polite and professional.
            """,
            chat_ctx=chat_ctx,
        )

    async def on_enter(self) -> None:
        await self.session.generate_reply(
            instructions="""
            Briefly introduce yourself, then ask for permission to record 
            the call for quality assurance and training purposes.
            Make it clear that they can decline.
            """
        )

    @function_tool()
    async def consent_given(self) -> None:
        """Use this when the user gives consent to record."""
        self.complete(True)

    @function_tool()
    async def consent_denied(self) -> None:
        """Use this when the user denies consent to record."""
        self.complete(False)

class ManagerAgent(Agent):
    def __init__(self, chat_ctx=None):
        super().__init__(
            instructions="""
            You are a customer service manager on a live phone call. You handle
            escalated issues that frontline agents couldn't resolve. Be empathetic
            and solution-focused. You have authority to offer refunds, credits,
            or other accommodations.
            Keep replies conversational and brief: 1-3 short sentences, under
            200 characters per sentence. Do not use markdown, lists, headings,
            or emojis. Ask one question at a time.
            """,
            chat_ctx=chat_ctx,
            tts=groq.TTS(
                model="canopylabs/orpheus-v1-english",
                voice="troy",
            ),
        )

    async def on_enter(self) -> None:
        await self.session.generate_reply(
            instructions="""
            Introduce yourself as a manager. Acknowledge that the customer 
            asked to speak with someone senior. Ask how you can help resolve 
            their concern.
            """
        )

# Define your agent's behavior by extending the Agent class
class Assistant(Agent):
    def __init__(self) -> None:
        super().__init__(
            instructions="""
            You are a friendly customer service representative on a live phone call. Help customers 
            with general inquiries. If they ask for a manager or you can't 
            resolve their issue, use the escalate_to_manager tool.
            Keep replies conversational and brief: 1-3 short sentences, under
            200 characters per sentence. Do not use markdown, lists, headings,
            or emojis. Ask one question at a time.
            """
        )

    @function_tool()
    async def escalate_to_manager(self, context: RunContext) -> ManagerAgent:
        """Transfer the customer to a manager when requested or when you cannot resolve their issue."""
        return ManagerAgent(chat_ctx=self.chat_ctx), "Transferring you to a manager now."

    async def on_enter(self) -> None:
        consent = await CollectConsent(chat_ctx=self.chat_ctx)
        
        if consent:
            await self.session.generate_reply(
                instructions="Thank them and offer your assistance."
            )
        else:
            await self.session.generate_reply(
                instructions="Let them know you understand and will proceed without recording."
            )

    

server = AgentServer()


# The entrypoint function runs when a participant joins the room
@server.rtc_session()
async def entrypoint(ctx: JobContext):
    missing_keys = [name for name in ("GROQ_API_KEY",) if not os.getenv(name)]
    if missing_keys:
        raise RuntimeError(
            f"Missing required environment variables: {', '.join(missing_keys)}"
        )

    # Configure the voice pipeline with STT, LLM, TTS, and VAD providers
    session = AgentSession(
        stt=groq.STT(
            model="whisper-large-v3-turbo",
            language="en",
            prompt="Technical support call. Terms: LiveKit, WebRTC, API, SIP, OAuth, token, room.",
        ),
        llm=groq.LLM(
            model="openai/gpt-oss-120b",
            temperature=0.4,
        ),
        tts=groq.TTS(
            model="canopylabs/orpheus-v1-english",
            voice="hannah",
        ),
        vad=silero.VAD.load(),                    # Voice activity detection
        turn_handling=TurnHandlingOptions(
            turn_detection=inference.TurnDetector(),
            # Dynamic endpointing learns how long the caller pauses mid-sentence,
            # so a short pause doesn't split one thought into separate turns.
            endpointing={
                "mode": "dynamic",
                "min_delay": 0.6,
                "max_delay": 4.0,
            },
            preemptive_generation={
                "preemptive_tts": False,
            },
        ),
    )

    # Aggregate data across all conversation turns
    usage_collector = metrics.UsageCollector()

    # Track End of Utterance timing (when turn detector decides user finished speaking)
    last_eou_metrics: metrics.EOUMetrics | None = None

    @session.on("metrics_collected")
    def _on_metrics_collected(ev: MetricsCollectedEvent):
        nonlocal last_eou_metrics
        # Capture EOU metrics for TTFA calculation
        if ev.metrics.type == "eou_metrics":
            last_eou_metrics = ev.metrics

        # Log each metric as it arrives and add to usage collector
        metrics.log_metrics(ev.metrics)
        usage_collector.collect(ev.metrics)


    async def log_usage():
        # Print per-session summary (tokens, audio duration, costs)
        summary = usage_collector.get_summary()
        logger.info("Usage summary: %s", summary)



    # Fire log_usage when worker shuts down
    ctx.add_shutdown_callback(log_usage)

    @session.on("agent_state_changed")
    def _on_agent_state_changed(ev: AgentStateChangedEvent):
        if ev.new_state == "speaking":
            if last_eou_metrics:
                # Calculate time since user finished speaking
                elapsed = time.time() - last_eou_metrics.timestamp
                logger.info(f"Time to first audio: {elapsed:.3f}s")


    # Start the session with noise cancellation enabled
    await session.start(
        agent=Assistant(),
        room=ctx.room,
        room_options=room_io.RoomOptions(
            audio_input=room_io.AudioInputOptions(
                noise_cancellation=noise_cancellation.BVC(),  # Background voice cancellation
            ),
        ),
    )


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    agents.cli.run_app(server)
