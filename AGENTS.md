Project is for a formula 1 data display and analysis

The backend is a simple typescript API that read session data from a TimescaleDB and expose the the app via REST API (the query should be sessionkey.) Located on the /backend folder

The frontend is a React app that load data from backend (no auth between user/front and front/back) and display the data
Located on the /frontend folder

If you need to check the data you can use psql cli with the url in the backend .env to connect and to display the data. Do NOT run any UPDATE or DELETE; read only unless the user state otherwise
