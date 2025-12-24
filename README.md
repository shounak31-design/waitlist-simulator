# waitlist-simulator
Interactive waitlist &amp; capacity simulator (GitHub Pages demo) modelling demand, DNAs and appointment capacity to estimate queue growth and wait-time KPIs — synthetic data, not clinical advice.

Methodology

This simulator was designed as a service-planning and scenario-testing tool rather than a clinical decision system. The aim was to model how waiting lists behave over time when demand, capacity, and non-attendance interact.

The model uses a daily time-step queue simulation. Each simulated day consists of:
	•	New referrals entering the system based on an average daily referral rate, with natural random variation.
	•	A fixed number of appointment slots representing available staffing capacity.
	•	A proportion of appointments resulting in non-attendance (DNA).
	•	A subset of DNAs being rebooked after a delay, creating additional downstream demand.
	•	Patients who attend being removed from the queue and their waiting time recorded.

The simulation runs over a configurable time horizon and includes a short warm-up period to allow the system to stabilise before performance metrics are calculated.

Key outputs include queue size over time, waiting-time distributions, and access performance metrics (e.g. percentage seen within 2, 4, or 6 weeks).

To support decision-making, the tool also includes scenario analysis. Baseline performance can be compared with alternative scenarios such as increasing capacity, reducing DNA rates, or adding workforce. For workforce scenarios, an illustrative cost model converts additional capacity into an estimated annual cost and calculates cost per week of waiting-time reduction, allowing trade-offs between cost and access improvement to be explored.

All inputs and outputs use synthetic data only. The model is intended for strategic planning, policy discussion, and demonstration purposes rather than operational scheduling or clinical use.
Rationale and Design Philosophy

The idea for this tool came from observing that discussions about waiting lists often focus on single metrics (e.g. average wait time) without considering the underlying system dynamics.

In practice, waiting lists are shaped by:
	•	demand variability,
	•	finite staffing capacity,
	•	non-attendance behaviour,
	•	and feedback loops such as rebooking.

Small changes in any of these factors can have non-linear effects on access and backlog growth.

The goal of this project was therefore to build a transparent, interactive model that:
	•	makes system behaviour visible,
	•	allows stakeholders to test assumptions,
	•	and supports structured conversations about trade-offs rather than “silver-bullet” solutions.

The emphasis was on clarity, explainability, and usability for non-technical audiences, reflecting how such tools are typically used in policy, service transformation, and consulting contexts.
