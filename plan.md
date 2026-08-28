

Web search - finding data, linking to sources, putting images
Multi step planning for outline/lesson plan? 




Many feature requests. Handle each of these individually. 
Can we have a "cancel" button on generation? And right now when I create a new primer asking for quant trading and cancel before sections are written (and before a previous primer finishes), exiting deletes the new primer - there isn't even an indication that it was ever requested. This is a bug we need to fix. 
Make sure that everything that goes wrong is visible, so the user should be able to tell what went wrong. Also, show which agents are currently running while the user waits, make sure everything is observable (errors) and visible when using the app. 
Add a small table of contents so the user can jump directly to any part of the primer. 
Add a "raw" page that shows the raw outputs of the models so we can inspect what's happening. 
Next, tell the section writer to be able to request actual diagrams/maps/graphs/visuals online, after which another image finder agent will go and scrape the web to find a suitable figure/diagram/map/graph/visual; it should do a vision check until it finds a good figure. And do the hover behavior for both the research agent and the image finder agent.
Add a research agent that runs afterwards that adds specific citations to key claims (ones that may be wrong) and can find hallucinations. Don't run it before. It should be post-hoc, but if it finds any misinformation or hallucination from the writing model, it should verify the possible misinformation or hallucination via the internet and, if it turns out to be wrong, edit the section. Don't show what it looked like before. 
Make a settings page that has things like: run research agent, show source from research agent. We will add more settings. 
Add a "rewrite" button that allows us to take an existing primer and rewrite with some feedback, i.e. you can press the rewrite button and ask the entire thing to be rewritten as a NEW primer, but a 3 paragraph summary, for instance, or the same thing but with more derivations. The 3 paragraph summary and other common rewrite requests should have a quickselect menu after pressing the button. 
Please make sure everything is done the most elegant, complete, clean, modular, extensible way possible. Don't make any other changes to prompts. 


STYLE changes: 
Don't