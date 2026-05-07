import asyncio
import logging
import os
from dotenv import load_dotenv
from browser_use import Agent, Controller, ActionResult, BrowserProfile
from langchain_openai import ChatOpenAI

load_dotenv()

# Show detailed logs so we can see what's happening
logging.basicConfig(level=logging.INFO)
logging.getLogger('browser_use').setLevel(logging.DEBUG)


class OpenAILLM(ChatOpenAI):
    @property
    def provider(self):
        return 'openai'

    def __getattr__(self, name):
        if name == 'model':
            return self.model_name
        raise AttributeError(f"'{type(self).__name__}' object has no attribute '{name}'")

    @staticmethod
    def _to_langchain_messages(messages):
        from langchain_core.messages import SystemMessage, HumanMessage, AIMessage, BaseMessage
        converted = []
        for msg in messages:
            if isinstance(msg, BaseMessage):
                converted.append(msg)
                continue
            content = getattr(msg, 'content', str(msg))
            if isinstance(content, list):
                # multi-part content — keep as-is
                pass
            name = type(msg).__name__.lower()
            role = getattr(msg, 'role', '')
            if 'system' in name or role == 'system':
                converted.append(SystemMessage(content=content))
            elif 'ai' in name or 'assistant' in name or role in ('assistant', 'ai'):
                converted.append(AIMessage(content=content))
            else:
                converted.append(HumanMessage(content=content))
        return converted

    async def ainvoke(self, input, config=None, *, output_format=None, **kwargs):
        # Strip browser-use telemetry kwargs that OpenAI API doesn't accept
        kwargs.pop('session_id', None)

        # Convert browser-use custom message types to standard langchain messages
        if isinstance(input, list):
            input = self._to_langchain_messages(input)

        if output_format is not None:
            structured = super().with_structured_output(
                output_format, method='function_calling', include_raw=False
            )
            return await structured.ainvoke(input, config, **kwargs)
        return await super().ainvoke(input, config, **kwargs)

    def __setattr__(self, name, value):
        if name == 'ainvoke':
            # Block browser-use's broken token-tracking wrapper — we handle
            # output_format correctly in our own ainvoke above.
            return
        try:
            super().__setattr__(name, value)
        except (ValueError, AttributeError):
            object.__setattr__(self, name, value)


controller = Controller()


@controller.action('Speed up all videos on the page to 1.5x playback rate')
async def speed_up_video(browser_session) -> ActionResult:
    try:
        page = browser_session.current_page
        await page.evaluate('''() => {
            document.querySelectorAll("video").forEach(v => v.playbackRate = 1.5);
            document.querySelectorAll("iframe").forEach(iframe => {
                try {
                    const doc = iframe.contentDocument || iframe.contentWindow.document;
                    doc.querySelectorAll("video").forEach(v => v.playbackRate = 1.5);
                } catch(e) {}
            });
        }''')
        return ActionResult(extracted_content='Video speed set to 1.5x')
    except Exception as e:
        return ActionResult(extracted_content=f'Could not speed up video: {e}')


async def main():
    llm = OpenAILLM(
        model='gpt-4o-mini',
        api_key=os.getenv('OPENAI_API_KEY'),
        temperature=0,
    )

    # Use a fresh Python-only profile folder — separate from Node.js user-data
    profile = BrowserProfile(
        headless=False,
        disable_security=True,
        user_data_dir=os.path.abspath('./user-data-python'),
    )

    task = """
You are an autonomous student agent completing an Edgenuity LMS course. Follow every step exactly.

==============================
STEP 1 — LOGIN
==============================
Go to: https://auth.edgenuity.com/Login/Login/Student

If you see a login form:
- Click the field with id="username" and type: Secor.zoe
- Click the field with id="password" and type: r9j5723t
- Click the button with type="submit"
- Wait for the page to fully load

If you are already on the dashboard (no login form), go to Step 2.

==============================
STEP 2 — OPEN COURSE
==============================
On the dashboard, find all buttons/cards with class "enrollment-card-btn-next".
Click the 5th one (index 4, counting from 0).
Wait up to 30 seconds for the course player iframe (#stageFrame) to appear.
Wait an additional 10 seconds for the iframe content to fully initialize.

==============================
STEP 3 — HANDLE EACH ACTIVITY (loop until all done)
==============================

First, check what type of activity is loaded inside the #stageFrame iframe:

--- IF VIDEO IS PRESENT ---
1. Call the speed_up_video action to set 1.5x speed
2. Wait for the video to finish
3. Click the "Next Activity" link (selector: a.footnav.goRight) on the outer page

--- IF QUESTIONS ARE PRESENT (quiz/assessment) ---
The questions appear inside the #stageFrame iframe.
Repeat this for each question (up to 10 questions total):

  1. Read the question text from inside the iframe
  2. Identify the question type:
       - Radio buttons → select the most correct answer option
       - Textarea or text input → type a 1-2 sentence student answer directly addressing the question
       - Rich text / CKEditor box → click inside it and type a student answer
  3. Answer the question BEFORE clicking any navigation button
  4. Look for a button with id="nextQuestion" inside the iframe → click it to go to the next question
  5. Wait 3 seconds, then repeat for the next question

  When id="nextQuestion" is NOT found but id="submit" IS found:
  - This is the final question
  - Confirm your answer is filled in
  - Click the button with id="submit"
  - Wait 8 seconds for the result page

  After submitting:
  - On the outer page, click the "Next Activity" link (selector: a.footnav.goRight)
  - Wait 10 seconds for the next activity to load
  - Go back to the top of Step 3

--- IF ONLY TEXT/INSTRUCTIONS (no video, no questions) ---
Look for a "Next", "Continue", or "Next Activity" button and click it.

==============================
IMPORTANT RULES
==============================
- NEVER click id="submit" before answering ALL questions
- ALWAYS use id="nextQuestion" to move between questions, not the submit button
- Only click id="submit" on the very last question when id="nextQuestion" is gone
- All question content and navigation buttons are INSIDE the #stageFrame iframe
- The "Next Activity" link (a.footnav.goRight) is on the OUTER page after submission
- If a button is not visible, scroll down to find it
- Continue until all activities are complete or "Course Complete" appears
"""

    agent = Agent(
        task=task,
        llm=llm,
        browser_profile=profile,
        controller=controller,
        use_vision=False,
        max_actions_per_step=5,
        max_failures=10,
    )

    print('Agent starting...')
    history = await agent.run(max_steps=500)
    print(f'\nAgent finished after {len(history.history)} steps')


if __name__ == '__main__':
    asyncio.run(main())
