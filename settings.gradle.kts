includeBuild("DashboardCore") {
	dependencySubstitution {
		substitute(module("com.acmerobotics.slothboard:core")).using(project(":"))
	}
}

includeBuild("FtcDashboard")

includeBuild("TeamCode")